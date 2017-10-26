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
    zoomLevels: number; // TODO(adb): zoomLevels = -1 --> downsample until the largest dimension is < 1k
    id: number;    
    fileExtension: string; //TODO(adb): enum? 
    tileHeight: number;
    tileWidth: number;
    tileSourceType: number;
    hostnames: string[];
}

interface StackMirror {
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
}

interface ProjectInfo {
    id: number;
    title: string;
    stacks: Map<string, StackIdentifier>;
}

function parseStackMirror(obj: any): StackMirror {
    let fileExtension = verifyObjectProperty(obj, 'file_extension', verifyString);
    let tileHeight = verifyObjectProperty(obj, 'tile_height', verifyInt);
    let tileWidth = verifyObjectProperty(obj, 'tile_width', verifyInt);
    let tileSourceType = verifyObjectProperty(obj, 'tile_source_type', verifyInt);
    let url = verifyObjectProperty(obj, 'image_base', verifyString);
    let position = verifyObjectProperty(obj, 'position', verifyInt);
    
    return {fileExtension, tileHeight, tileWidth, tileSourceType, url, position};
}

function parseStackInfo(obj: any): StackInfo {
    verifyObject(obj);
        
    let dimension: vec3 = verifyObjectProperty(obj, 'dimension', dimensionObj => {
        let x = verifyObjectProperty(dimensionObj, 'x', verifyInt);
        let y = verifyObjectProperty(dimensionObj, 'y', verifyInt);
        let z = verifyObjectProperty(dimensionObj, 'z', verifyInt);
        return vec3.fromValues(x, y, z);
    });

    let translation: vec3 = verifyObjectProperty(obj, 'translation', translationObj => {
        let x = verifyObjectProperty(translationObj, 'x', verifyInt);
        let y = verifyObjectProperty(translationObj, 'y', verifyInt);
        let z = verifyObjectProperty(translationObj, 'z', verifyInt);
        return vec3.fromValues(x, y, z);
    });

    let resolution: vec3 = verifyObjectProperty(obj, 'resolution', (resolutionObj => {
        let x = verifyObjectProperty(resolutionObj, 'x', verifyFloat);
        let y = verifyObjectProperty(resolutionObj, 'y', verifyFloat);
        let z = verifyObjectProperty(resolutionObj, 'z', verifyFloat);
        return vec3.fromValues(x, y, z);
    }));

    let zoomLevels = verifyObjectProperty(obj, 'num_zoom_levels', verifyInt);

    let id = verifyObjectProperty(obj, 'sid', verifyInt);
    
    let stackMirrors = verifyObjectProperty(obj, 'mirrors', mirrorsArrObj => {
        return parseArray(mirrorsArrObj, parseStackMirror)});

    // TODO(adb): clean this up -- maybe we can sort? 
    let minPosition = 10000;
    let stackMirrorIdx = 0;
    for (let i = 0; i < stackMirrors.length; i++) {
        if (stackMirrors[i].position < minPosition) {
            stackMirrorIdx = i;
            minPosition = stackMirrors[i].position; 
        }
    }
    let stackMirror = stackMirrors[stackMirrorIdx];
    let fileExtension = stackMirror.fileExtension;
    let tileHeight = stackMirror.tileHeight;
    let tileWidth = stackMirror.tileWidth;
    let tileSourceType = stackMirror.tileSourceType;
    let hostnames = [stackMirror.url];

    return {dimension, translation, resolution, zoomLevels, id, fileExtension, tileHeight, tileWidth, tileSourceType, hostnames};
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
                return { id, title };
            });
            for (let stackInfo of stackInfoArr) {
                stacks.set(stackInfo.title, stackInfo);
            }
        });
        projects.set(title, { id, title, stacks });
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

    constructor(public chunkManager: ChunkManager, public url: string, public projectInfo: ProjectInfo, public stackInfo: StackInfo, public parameters: {[index: string]: any} = {}) {

        if (projectInfo === undefined) {
            throw new Error(`Failed to read project information from CATMAID`);
        }

        if (stackInfo === undefined) {
            throw new Error(`Failed to read stack information for project ${projectInfo.title} from CATMAID.`);
        }

        this.encoding = TileEncoding.JPEG;
    }

    getSources(volumeSourceOptions: VolumeSourceOptions) {
        let sources: VolumeChunkSource[][] = [];

        let numLevels = this.stackInfo.zoomLevels;

        for (let level = 0; level < numLevels; level++) {
            let voxelSize = vec3.clone(this.stackInfo.resolution);
            let chunkDataSize = vec3.fromValues(1, 1, 1);

            for(let i=0; i<2; ++i) {
                voxelSize[i] = voxelSize[i] * Math.pow(2, level);
            }

            chunkDataSize[0] = this.stackInfo.tileWidth;
            chunkDataSize[1] = this.stackInfo.tileHeight;

            let lowerVoxelBound = vec3.create(), upperVoxelBound = vec3.create();

            for(let i=0; i<3; i++) {
                lowerVoxelBound[i] = Math.floor(this.stackInfo.translation[i] * (this.stackInfo.resolution[i] / voxelSize[i]));
                upperVoxelBound[i] = Math.ceil((this.stackInfo.dimension[i] + this.stackInfo.translation[i]) * (this.stackInfo.resolution[i] / voxelSize[i]));
            }

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
                    'sourceBaseUrls': this.stackInfo.hostnames,
                    'encoding': this.encoding,
                    'zoomLevel': level,
                    'tileHeight': this.stackInfo.tileHeight,
                    'tileWidth': this.stackInfo.tileWidth
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
    const urlPatternComplete = /^((?:http|https):\/\/[^?]+)\/(.*)\/(.*)$/;
    let match = path.match(urlPatternComplete);

    if (match === null) {
        throw new Error(`Invalid catmaid tile path ${JSON.stringify(path)}`);
    }

    const url = match[1];
    const project = match[2];
    const stack = match[3];

    // TODO(adb): support parameters
    // const parameters = parseQueryStringParameters(match[4] || '');
    
    return chunkManager.memoize.getUncounted({ type: 'catmaid:MultiscaleVolumeChunkSource', url, path }, () => getProjectsList(chunkManager, [url]).then(projectsList => {
        let projectInfo = projectsList.get(project);
        if (projectInfo === undefined) {
            throw new Error(`Unable to find project ${project} in projects list`);
        }

        let stackIdentifier = projectInfo.stacks.get(stack);
        if (stackIdentifier === undefined) {
            throw new Error(`Unable to find stack ${stack} in project ${project}`);
        }
        return getStackInfo(chunkManager, url, projectInfo.id, stackIdentifier.id).then(stackInfo => { return new MultiscaleTileSource(chunkManager, url, projectInfo!,stackInfo)});

    }));
}

export function getStackInfo(chunkManager: ChunkManager, hostname: string, projectId: number, stackId: number) {
    return chunkManager.memoize.getUncounted({ type: 'catmaid:getStackInfo', hostname, projectId, stackId }, () => sendHttpRequest(openShardedHttpRequest(hostname, `/${projectId}/stack/${stackId}/info`), 'json').then(parseStackInfo));
}

// TODO(adb): refactor this to take hostnames and a post path, so we can separate out the base hostname from the server(s) and any prefix (which we will need later)
export function getProjectsList(chunkManager: ChunkManager, hostnames: string[]) {
    return chunkManager.memoize.getUncounted({ type: 'catmaid:getProjectsList', hostnames }, () => sendHttpRequest(openShardedHttpRequest(hostnames, `/projects/`), 'json').then(parseProjectsList));
}

export function autoCompleteProject(projectTitlePartial: string, url: string, projectsList: Map<string, ProjectInfo>) {
    console.log(url);
    let completions = getPrefixMatchesWithDescriptions(projectTitlePartial, projectsList, x => x[0] + '/', () => undefined);
    return { offset: 0, completions };
}

export function autoCompleteStack(stackTitlePartial: string, projectTitle: string, url: string, projectsList: Map<string, ProjectInfo>) {
    console.log(url);

    let projectInfo = projectsList.get(projectTitle);
    if (projectInfo === undefined) {
        throw new Error(`Unable to find project ${projectTitle} in projects list`);
    }

    let completions = getPrefixMatchesWithDescriptions(stackTitlePartial, projectInfo.stacks, x => x[0], x => { return `${x[1].title}`; });
    return { offset: projectTitle.length + 1, completions };
}

export function projectAndStackCompleter(chunkManager: ChunkManager, hostnames: string[], path: string) {
    let pathSplit = path.split('/');
    if (pathSplit.length > 1) {
        let pathTmp = pathSplit;
        let stackTitle = pathTmp.pop();
        let projectTitle = pathTmp.pop();

        if (projectTitle === undefined) {
            return Promise.reject<CompletionResult>(null);
        }

        let url = hostnames[0] +  '/' + pathTmp.join();
        if (stackTitle === undefined) {
            // Try and autocomplete the project
            return getProjectsList(chunkManager, [url]).then(projectsList => { return autoCompleteProject(projectTitle!, url, projectsList); });
        }

        return getProjectsList(chunkManager, [url]).then(projectsList => { return autoCompleteStack(stackTitle!, projectTitle!, url, projectsList); });

    } else {
        // Try and complete the project with the base URL
        let url = hostnames[0];
        /*
        if (path.length > 0) {
            url = url + '/' + path;
        }
        */
        return getProjectsList(chunkManager, [url]).then(projectsList => {
            return autoCompleteProject("", url, projectsList);
        });
    }
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
        return projectAndStackCompleter(chunkManager, hostnamesBase, path).then(completions => applyCompletionOffset(match![1].length + 1, completions));
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