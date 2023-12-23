// polls devices
async function getConnectedDevices(type) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return type ? devices.filter(device => device.kind === type) : devices;
}

// just a short hand for getUserMedia
async function openMediaDevices(constraints) {
    return await navigator.mediaDevices.getUserMedia(constraints);
}

function setupVideoElement() {
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;

    document.body.appendChild(video);
    return video;
}

// pipe 
async function captureWebcamTo(dom, start) {
    const constrains = {
        // https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
        'video': {
            // facingMode: { exact: "user" },
            // facingMode: 'environment',
        },
        'audio': false
        // 'audio': { 'echoCancellation': true },
        // 'video': {
        //     'deviceId': cameraId,
        //     'width': { 'min': minWidth },
        //     'height': { 'min': minHeight }
        // }
    };

    try {
        const stream = await openMediaDevices(constrains);
        console.log('Got MediaStream:', stream);

        dom.srcObject = stream;
        dom.onloadedmetadata = () => {
            dom.play();
            start && start();
        };
    } catch (error) {
        console.error('Error accessing media devices.', error);
    }
}