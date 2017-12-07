/**
 * @license
 * Copyright 2017 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ChunkManager, WithParameters } from 'neuroglancer/chunk_manager/frontend';
import { TileSourceParameters, TileEncoding, SkeletonSourceParameters} from 'neuroglancer/datasource/catmaid/base';
import { CompletionResult, DataSource } from 'neuroglancer/datasource';
import { MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource } from 'neuroglancer/sliceview/volume/frontend';
import { DataType, VolumeChunkSpecification, VolumeSourceOptions, VolumeType } from 'neuroglancer/sliceview/volume/base';
import { parseArray, verifyFloat, verifyInt, verifyObject, verifyObjectProperty, verifyString } from 'neuroglancer/util/json';
import { openShardedHttpRequest, sendHttpRequest } from 'neuroglancer/util/http_request';
import { vec3 } from 'neuroglancer/util/geom';
import {applyCompletionOffset, getPrefixMatchesWithDescriptions} from 'neuroglancer/util/completion';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';


class CatmaidTileSource extends (WithParameters(VolumeChunkSource, TileSourceParameters)) { }

class CatmaidSkeletonSource extends (WithParameters(SkeletonSource, SkeletonSourceParameters)) {
    get skeletonVertexCoordinatesInVoxels() {
        return false;
    }
}

interface StackInfo {
    dimension: vec3;
    translation: vec3;
    resolution: vec3;
    zoomLevels: number;
    id: number;
    mirrors: Map<string, StackMirror>;
}

interface StackMirror {
    id: number;
    title: string;
    fileExtension: string;
    tileHeight: number;
    tileWidth: number;
    tileSourceType: number;
    url: string;
    position: number;
}

interface StackIdentifier {
    id: number;
    title: string;
    comment: string;
}

interface ProjectInfo {
    id: number;
    title: string;
    stacks: Map<string, StackIdentifier>;
}

function parseStackMirror(obj: any): StackMirror {
    let id = verifyObjectProperty(obj, 'id', verifyInt);
    let title = verifyObjectProperty(obj, 'title', verifyString);
    let fileExtension = verifyObjectProperty(obj, 'file_extension', verifyString);
    let tileHeight = verifyObjectProperty(obj, 'tile_height', verifyInt);
    let tileWidth = verifyObjectProperty(obj, 'tile_width', verifyInt);
    let tileSourceType = verifyObjectProperty(obj, 'tile_source_type', verifyInt);
    let url = verifyObjectProperty(obj, 'image_base', verifyString);
    let position = verifyObjectProperty(obj, 'position', verifyInt);

    return {id, title, fileExtension, tileHeight, tileWidth, tileSourceType, url, position};
}

function parseStackInfo(obj: any): StackInfo {
    verifyObject(obj);

    function verifyObjectVec(obj: any, vecField: string, typeVerifier: (...args: any[]) => number): vec3 {
        return verifyObjectProperty(obj, vecField, vecObj => {
            let x = verifyObjectProperty(vecObj, 'x', typeVerifier);
            let y = verifyObjectProperty(vecObj, 'y', typeVerifier);
            let z = verifyObjectProperty(vecObj, 'z', typeVerifier);
            return vec3.fromValues(x, y, z);
        })
    }

    let dimension = verifyObjectVec(obj, 'dimension', verifyInt);
    let translation = verifyObjectVec(obj, 'translation', verifyInt);
    let resolution = verifyObjectVec(obj, 'resolution', verifyFloat);

    let zoomLevels = verifyObjectProperty(obj, 'num_zoom_levels', verifyInt);

    let id = verifyObjectProperty(obj, 'sid', verifyInt);

    let mirrors = verifyObjectProperty(obj, 'mirrors', mirrorsArrObj => {
        return parseArray(mirrorsArrObj, parseStackMirror)
    }).reduce((mirrors, m) => { mirrors.set(m.id.toString(), m); return mirrors; },
              new Map<string, StackMirror>());

    return {dimension, translation, resolution, zoomLevels, id, mirrors};
}

function parseProjectsList(obj: any): Map<string, ProjectInfo> {
    let projectObjs = parseArray(obj, verifyObject);

    if (projectObjs.length < 1) {
        throw new Error('No projects found in projects list.');
    }

    let projects = new Map<string, ProjectInfo>();

    for (let projectObj of projectObjs) {
        let id = verifyObjectProperty(projectObj, 'id', verifyInt);
        let title = verifyObjectProperty(projectObj, 'title', verifyString);
        let stacks = new Map<string, StackIdentifier>();
        verifyObjectProperty(projectObj, 'stacks', x => {
            let stackInfoArr = parseArray(x, stackDescObj => {
                let id = verifyObjectProperty(stackDescObj, 'id', verifyInt);
                let title = verifyObjectProperty(stackDescObj, 'title', verifyString);
                let comment = verifyObjectProperty(stackDescObj, 'comment', verifyString);
                return { id, title, comment };
            });
            for (let stackInfo of stackInfoArr) {
                stacks.set(stackInfo.id.toString(), stackInfo);
            }
        });
        projects.set(id.toString(), { id, title, stacks });
    }

    return projects;
}


export class MultiscaleTileSource implements GenericMultiscaleVolumeChunkSource {
    get dataType() {
        return DataType.UINT8;
    }
    get numChannels() {
        return 1;
    }
    get volumeType() {
        return VolumeType.IMAGE;
    }

    encoding: TileEncoding;

    constructor(
            public chunkManager: ChunkManager,
            public url: string,
            // public projectInfo: ProjectInfo,
            public stackInfo: StackInfo,
            public mirrorId: string,
            public parameters: {[index: string]: any} = {}) {

        // if (projectInfo === undefined) {
        //     throw new Error(`Failed to read project information from CATMAID`);
        // }

        if (stackInfo === undefined) {
            throw new Error(`Failed to read stack information for stack from CATMAID.`);
        }

        this.encoding = TileEncoding.JPEG;
    }

    getSources(volumeSourceOptions: VolumeSourceOptions) {
        let sources: VolumeChunkSource[][] = [];
        let mirror = this.stackInfo.mirrors.get(this.mirrorId);
        if (mirror === undefined) {
            throw new Error(`Unable to find mirror ${this.mirrorId} for stack`);
        }

        let numLevels = this.stackInfo.zoomLevels;

        // Zoom level of -1 indicates the maximum zoom level is such that the
        // XY-extents of the stack at that level are less than 1K.
        if (numLevels < 0) {
            numLevels = Math.ceil(Math.max(Math.log2(this.stackInfo.dimension[0] / 1024),
                                           Math.log2(this.stackInfo.dimension[1] / 1024)));
        }

        for (let level = 0; level <= numLevels; level++) {
            let voxelSize = vec3.clone(this.stackInfo.resolution);
            let chunkDataSize = vec3.fromValues(1, 1, 1);

            for(let i=0; i<2; ++i) {
                voxelSize[i] = voxelSize[i] * Math.pow(2, level);
            }

            chunkDataSize[0] = mirror.tileWidth;
            chunkDataSize[1] = mirror.tileHeight;

            let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.clone(this.stackInfo.dimension);

            // for(let i=0; i<3; i++) {
            //     lowerVoxelBound[i] = Math.floor(this.stackInfo.translation[i] / voxelSize[i]);
            //     upperVoxelBound[i] = Math.ceil((this.stackInfo.dimension[i] * this.stackInfo.resolution[i] + this.stackInfo.translation[i]) / voxelSize[i]);
            // }

            let spec = VolumeChunkSpecification.make({
                voxelSize,
                chunkDataSize,
                numChannels: this.numChannels,
                dataType: this.dataType,
                lowerVoxelBound,
                upperVoxelBound,
                volumeSourceOptions
            });

            let source = this.chunkManager.getChunkSource(CatmaidTileSource, {
                spec,
                parameters: {
                    'sourceBaseUrls': mirror.url,
                    'encoding': this.encoding,
                    'zoomLevel': level,
                    'tileHeight': mirror.tileHeight,
                    'tileWidth': mirror.tileWidth,
                    'tileSourceType': mirror.tileSourceType,
                }
            });

            sources.push([source]);
        }
        return sources;
    }

    /**
     * Meshes are not supported.
     */
    getMeshSource(): null {
        return null;
    }
}

export function getVolume(chunkManager: ChunkManager, path: string) {
    const urlPatternComplete = /^((?:http|https):\/\/[^?]+)\/(.*)\/(.*)\/(.*)$/;
    let match = path.match(urlPatternComplete);

    if (match === null) {
        throw new Error(`Invalid catmaid tile path ${JSON.stringify(path)}`);
    }

    const url = match[1];
    const project = match[2];
    const stack = match[3];
    const mirror = match[4];

    // TODO(adb): support parameters
    // const parameters = parseQueryStringParameters(match[4] || '');

    return chunkManager.memoize.getUncounted(
                { type: 'catmaid:MultiscaleVolumeChunkSource', url, path },
                () => getStackInfo(chunkManager, url, Number(project), Number(stack)).then(stackInfo => {
                    return new MultiscaleTileSource(chunkManager, url, stackInfo, mirror);
                }));
    //             () => getProjectsList(chunkManager, [url]).then(projectsList => {
    //     let projectInfo = projectsList.get(project);
    //     if (projectInfo === undefined) {
    //         throw new Error(`Unable to find project ${project} in projects list`);
    //     }

    //     let stackIdentifier = projectInfo.stacks.get(stack);
    //     if (stackIdentifier === undefined) {
    //         throw new Error(`Unable to find stack ${stack} in project ${project}`);
    //     }
    //     return getStackInfo(chunkManager, url, projectInfo.id, stackIdentifier.id)
    //         .then(stackInfo => { return new MultiscaleTileSource(chunkManager, url, projectInfo!, stackInfo) });

    // }));
}

export function getStackInfo(chunkManager: ChunkManager, hostname: string, projectId: number, stackId: number) {
    return chunkManager.memoize.getUncounted(
            { type: 'catmaid:getStackInfo', hostname, projectId, stackId },
            () => sendHttpRequest(openShardedHttpRequest(hostname, `/${projectId}/stack/${stackId}/info`), 'json')
        .then(parseStackInfo));
}

// TODO(adb): refactor this to take hostnames and a post path, so we can separate out the base hostname from the server(s) and any prefix (which we will need later)
export function getProjectsList(chunkManager: ChunkManager, hostnames: string[]) {
    return chunkManager.memoize.getUncounted(
            { type: 'catmaid:getProjectsList', hostnames },
            () => sendHttpRequest(openShardedHttpRequest(hostnames, `/projects/`), 'json')
        .then(parseProjectsList));
}

export function autoCompleteProject(projectIdPartial: string, offset: number, projectsList: Map<string, ProjectInfo>) {
    let completions = getPrefixMatchesWithDescriptions(
            projectIdPartial,
            projectsList.values(),
            x => x.id + '/',
            x => x.title);
    return { offset: offset, completions };
}

export function autoCompleteStack(stackIdPartial: string, projectId: string, offset:number, projectsList: Map<string, ProjectInfo>) {
    let projectInfo = projectsList.get(projectId);
    if (projectInfo === undefined) {
        throw new Error(`Unable to find project ${projectId} in projects list`);
    }

    let completions = getPrefixMatchesWithDescriptions(
            stackIdPartial,
            projectInfo.stacks.values(),
            x => x.id.toString() + '/',
            x => `${x.title}: ${x.comment}`);
    return { offset: offset, completions };
}

export function autoCompleteMirror(mirrorIdPartial: string, offset: number, mirrorsList: Map<string, StackMirror>) {
    let completions = getPrefixMatchesWithDescriptions(
            mirrorIdPartial,
            [...mirrorsList.values()].sort((a, b) => a.position - b.position),
            x => x.id.toString(),
            x => `${x.title}`);
    return { offset: offset, completions };
}

export function projectStackMirrorCompleter(chunkManager: ChunkManager, hostnames: string[], path: string) {
    let pathSplit = path.split('/');

    let projectId = pathSplit.pop(), stackId = '', mirrorId = '';
    let url = [hostnames[0]].concat(pathSplit).join('/');
    let offset = path.length - projectId!.length;
    return getProjectsList(chunkManager, [url])
            .then(projectsList => { return autoCompleteProject(projectId!, offset, projectsList); })
            .catch(projectError => {
                if (pathSplit.length) {
                    stackId = projectId!;
                    projectId = pathSplit.pop();
                    url = [hostnames[0]].concat(pathSplit).join('/');

                    return getProjectsList(chunkManager, [url])
                        .then(projectsList => { return autoCompleteStack(stackId!, projectId!, offset, projectsList); })
                        .catch(stackError => {
                            if (pathSplit.length) {
                                mirrorId = stackId;
                                stackId = projectId!;
                                projectId = pathSplit.pop();
                                url = [hostnames[0]].concat(pathSplit).join('/');

                                return getStackInfo(chunkManager, url, Number(projectId), Number(stackId))
                                    .then(stackInfo => { return autoCompleteMirror(mirrorId!, offset, stackInfo.mirrors); });
                            } else {
                                throw stackError;
                            }
                        });
                } else {
                    throw projectError;
                }
            });

    // switch (pathSplit.length) {
    //     case 1: {
    //         let [projectId] = pathSplit;
    //         let url = hostnames[0];
    //         return getProjectsList(chunkManager, [url])
    //             .then(projectsList => { return autoCompleteProject(projectId!, url, projectsList); });
    //     }
    //     case 2: {
    //         let [projectId, stackId] = pathSplit;
    //         let url = hostnames[0];
    //         return getProjectsList(chunkManager, [url])
    //             .then(projectsList => { return autoCompleteStack(stackId!, projectId!, url, projectsList); });
    //     }
    //     default: {
    //         let mirrorId = pathSplit.pop();
    //         let stackId = pathSplit.pop();
    //         let projectId = pathSplit.pop();
    //         let url = [hostnames[0]].concat(pathSplit).join('/');
    //         return getStackInfo(chunkManager, url, Number(projectId), Number(stackId))
    //             .then(stackInfo => { return autoCompleteMirror(mirrorId!, stackId!, projectId!, stackInfo.mirrors); });
    //     }
    // }
}

export class CatmaidDataSource extends DataSource {
    get description() {
        return 'Catmaid';
    }

    getVolume(chunkManager: ChunkManager, url: string) {
        return getVolume(chunkManager, url);
    }

    volumeCompleter(url: string, chunkManager: ChunkManager) {
        const urlPattern = /^((?:http|https):\/\/[^\/?]+)\/(.*)$/;
        let match = url.match(urlPattern);
        if (match === null) {
            // We don't yet have a full catmaid path
            return Promise.reject<CompletionResult>(null);
        }
        let hostnamesBase = [match[1]];
        let path = match[2];
        return projectStackMirrorCompleter(chunkManager, hostnamesBase, path)
            .then(completions => applyCompletionOffset(match![1].length + 1, completions));
    }

    getSkeletonSourceParameters(chunkManager: ChunkManager, url: string): Promise<SkeletonSourceParameters> {
        const skeletonSourcePattern = /^((?:http|https):\/\/[^\/?]+)\/(?:[^\/?]+\/)?(.*)$/;
        let match = url.match(skeletonSourcePattern);
        if (match === null || match[1] === undefined) {
            throw new Error(`Invalid Catmaid skeleton URL: ${url}`);
        }

        const hostname = match[1];
        const project = match[2];
        if (project === undefined) {
            throw new Error(`No Catmaid project specified.`);
        }

        console.log(hostname);
        return getProjectsList(chunkManager, [hostname]).then(projectsList => {
            let projectInfo = projectsList.get(project);
            if (projectInfo === undefined) {
                throw new Error(`Unable to load Catmaid project: ${JSON.stringify(project)}`);
            }
            return {
                catmaidServerUrl: hostname,
                projectId: projectInfo.id
            }
        });
    }


    getSkeletonSource(chunkManager: ChunkManager, url: string) {
        console.log(url);
        return this.getSkeletonSourceParameters(chunkManager, url).then(
            parameters => {
                return chunkManager.getChunkSource(CatmaidSkeletonSource, {parameters: parameters});
            }
        );
    }
}
