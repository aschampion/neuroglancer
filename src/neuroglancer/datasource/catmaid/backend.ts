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

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {TileEncoding, TileSourceParameters, SkeletonSourceParameters} from 'neuroglancer/datasource/catmaid/base';
import {decodeSkeletonVertexPositionsAndIndices, SkeletonSource, SkeletonChunk} from 'neuroglancer/skeleton/backend';
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {openShardedHttpRequest, sendHttpRequest} from 'neuroglancer/util/http_request';
import {Endianness} from 'neuroglancer/util/endian';

const CHUNK_DECODERS = new Map([
    [TileEncoding.JPEG, decodeJpegChunk]
]);

@registerSharedObject()
export class CatmaidTileSource extends (WithParameters(VolumeChunkSource, TileSourceParameters)) {

    download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
        let chunkDecoder = CHUNK_DECODERS.get(TileEncoding.JPEG)!;

        let {parameters} = this;
        let {chunkGridPosition} = chunk;

        // Needed by JPEG decoder.
        chunk.chunkDataSize = this.spec.chunkDataSize;
    
        // Tile Source 5
        // <sourceBaseUrl><zoomLevel>/<pixelPosition.z>/<row>/<col>.<fileExtension>

        // TODO(adb): check source base url for slash in frontend

        // TODO(adb): read tile extension from stack mirror
        let path = `${parameters.zoomLevel}/${chunkGridPosition[2]}/${chunkGridPosition[1]}/${chunkGridPosition[0]}.jpg`

        return sendHttpRequest(openShardedHttpRequest(parameters.sourceBaseUrls, path), 'arraybuffer', cancellationToken).then(response => chunkDecoder(chunk, response));
    }

}

function decodeSkeletonChunk(chunk: SkeletonChunk, response: ArrayBuffer) {
    let dv = new DataView(response);
    let numVertices = dv.getUint32(0, true);
    let numVerticesHigh = dv.getUint32(4, true);
    if (numVerticesHigh !== 0) {
      throw new Error(`The number of vertices should not exceed 2^32-1.`);
    }
    let numEdges = dv.getUint32(8, true);
    let numEdgesHigh = dv.getUint32(12, true);
    if (numEdgesHigh !== 0) {
      throw new Error(`The number of edges should not exceed 2^32-1.`);
    }
    decodeSkeletonVertexPositionsAndIndices(
        chunk, response, Endianness.LITTLE, /*vertexByteOffset=*/16, numVertices,
        /*indexByteOffset=*/undefined, /*numEdges=*/numEdges);
  }
  
  @registerSharedObject() export class CatmaidSkeletonSource extends (WithParameters(SkeletonSource, SkeletonSourceParameters)) {
    download(chunk: SkeletonChunk, cancellationToken: CancellationToken) {
      const {parameters} = this;
      let requestPath = `/${parameters.projectId}/skeletons/${chunk.objectId}/neuroglancer`;
      return sendHttpRequest(
                 openShardedHttpRequest(parameters.catmaidServerUrl, requestPath), 'arraybuffer',
                 cancellationToken)
          .then(response => decodeSkeletonChunk(chunk, response));
    }
  }