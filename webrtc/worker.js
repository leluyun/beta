/*
 *  Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

/*
 * This is a worker doing the encode/decode transformations to add end-to-end
 * encryption to a WebRTC PeerConnection using the Insertable Streams API.
 */

'use strict';
let currentCryptoKey;
let useCryptoOffset = true;
let currentKeyIdentifier = 0;

// If using crypto offset (controlled by a checkbox):
// Do not encrypt the first couple of bytes of the payload. This allows
// a middle to determine video keyframes or the opus mode being used.
// For VP8 this is the content described in
//   https://tools.ietf.org/html/rfc6386#section-9.1
// which is 10 bytes for key frames and 3 bytes for delta frames.
// For opus (where encodedFrame.type is not set) this is the TOC byte from
//   https://tools.ietf.org/html/rfc6716#section-3.1
// TODO: make this work for other codecs.
//
// It makes the (encrypted) video and audio much more fun to watch and listen to
// as the decoder does not immediately throw a fatal error.
const frameTypeToCryptoOffset = {
    key: 10,
    delta: 3,
    undefined: 1,
};

function dump(encodedFrame, direction, max = 16) {
    const data = new Uint8Array(encodedFrame.data);
    let bytes = '';
    for (let j = 0; j < data.length && j < max; j++) {
        bytes += (data[j] < 16 ? '0' : '') + data[j].toString(16) + ' ';
    }
    const metadata = encodedFrame.getMetadata();
    console.log(performance.now().toFixed(2), direction, bytes.trim(),
        'len=' + encodedFrame.data.byteLength,
        'type=' + (encodedFrame.type || 'audio'),
        'ts=' + (metadata.rtpTimestamp || encodedFrame.timestamp),
        'ssrc=' + metadata.synchronizationSource,
        'pt=' + (metadata.payloadType || '(unknown)'),
        'mimeType=' + (metadata.mimeType || '(unknown)'),
    );
}

let scount = 0;
function encodeFunction(encodedFrame, controller) {
    const startTime = performance.now();

    try {
        // 添加元数据到视频帧
        addMetadataToFrame(frame);
        controller.enqueue(frame);

        // 更新统计信息
        const processTime = performance.now() - startTime;
        totalProcessingTime += processTime;
        frameCount++;

        // 计算FPS
        const now = Date.now();
        if (lastFrameTime > 0) {
            const elapsed = now - lastFrameTime;
            fps = Math.round(1000 / elapsed);
        }
        lastFrameTime = now;

        updateStats();
    } catch (err) {
        console.error("发送端处理帧出错:", err);
        controller.enqueue(frame); // 出错时发送原始帧
    }
}

// 向视频帧添加元数据
async function addMetadataToFrame(frame) {
    const data = new Uint8Array(await frame.data);

    // 创建元数据头 (12字节)
    const metaHeader = new Uint8Array(METADATA_HEADER_SIZE);
    const dataView = new DataView(metaHeader.buffer);

    // 填充元数据 (示例)
    dataView.setUint32(0, Date.now());        // 时间戳
    dataView.setUint16(4, frame.type === 'key' ? 1 : 0); // 关键帧标志
    dataView.setUint16(6, frameCount);        // 帧计数
    dataView.setUint32(8, data.length);       // 原始帧大小

    // 合并元数据和帧数据
    const combined = new Uint8Array(metaHeader.length + data.length);
    combined.set(metaHeader);
    combined.set(data, metaHeader.length);
    frame.data = combined.buffer
}

let rcount = 0;
function decodeFunction(encodedFrame, controller) {
    const startTime = performance.now();

    try {
        // 提取元数据并恢复原始帧
        extractedMetadata = extractMetadataFromFrame(frame);
        controller.enqueue(frame);

        // 处理元数据
        if (extractedMetadata != undefined) {
            processMetadata(extractedMetadata);
        }

        // 更新统计信息
        const processTime = performance.now() - startTime;
        totalProcessingTime += processTime;
        frameCount++;
        updateStats();
    } catch (err) {
        console.error("接收端处理帧出错:", err);
        controller.enqueue(frame); // 出错时传递原始帧
    }
}

// 从视频帧提取元数据
async function extractMetadataFromFrame(frame) {
    const data = new Uint8Array(await frame.data);

    // 确保有足够的元数据
    if (data.length < METADATA_HEADER_SIZE) {
        return metadata
    }

    // 提取元数据头
    const metaHeader = data.slice(data.buffer.byteLength - METADATA_HEADER_SIZE, data.buffer.byteLength);
    const dataView = new DataView(metaHeader.buffer);

    // 解析元数据
    const metadata = {
        timestamp: dataView.getUint32(0),
        isKeyFrame: dataView.getUint16(4) === 1,
        frameNumber: dataView.getUint16(6),
        frameSize: dataView.getUint32(8)
    };

    // 提取原始帧数据
    const frameData = data.slice(0, data.buffer.byteLength - METADATA_HEADER_SIZE);
    frame.data = frameData.buffer

    return metadata
}

function handleTransform(operation, readable, writable) {
    if (operation === 'encode') {
        const transformStream = new TransformStream({
            transform: encodeFunction,
        });
        readable
            .pipeThrough(transformStream)
            .pipeTo(writable);
    } else if (operation === 'decode') {
        const transformStream = new TransformStream({
            transform: decodeFunction,
        });
        readable
            .pipeThrough(transformStream)
            .pipeTo(writable);
    }
}

// Handler for messages, including transferable streams.
onmessage = (event) => {
    if (event.data.operation === 'encode' || event.data.operation === 'decode') {
        return handleTransform(event.data.operation, event.data.readable, event.data.writable);
    }
};

// Handler for RTCRtpScriptTransforms.
if (self.RTCTransformEvent) {
    self.onrtctransform = (event) => {
        const transformer = event.transformer;
        handleTransform(transformer.options.operation, transformer.readable, transformer.writable);
    };
}
