var lastLapsed;

async function loadModel() {
    const start = Date.now()
    // Create a detector.
    const model = poseDetection.SupportedModels.BlazePose;
    const detectorConfig = {
        runtime: 'mediapipe',
        modelType: 'lite', //  'lite', 'full', 'heavy'
        enableSegmentation: false,
        solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose'
        // or 'base/node_modules/@mediapipe/pose' in npm.
    };

    let detector;

    try {
        detector = await poseDetection.createDetector(model, detectorConfig);
    } catch (e) {
        console.error(e)
    }

    console.log('Model took', Date.now() - start, 'ms')
    return detector
}

class Analyzer {
    constructor(source) {
        // source dom (assumes video)
        this.source = source;
        init(source)
    }

    // processing loop
    async process() {
        const start = Date.now();
        const estimationConfig = { enableSmoothing: true };
        window.poses = await detector.estimatePoses(this.source, estimationConfig);
        const took = Date.now() - start;

        var pose = poses[0];

        // show results
        ctx.fillStyle = '#ddd';
        ctx.clearRect(0, 0, width, height);
        if (pose) {
            var scores = pose.keypoints.map(p => p.score);
            var min_score = Math.min(...scores);
            var sum = scores.reduce((accum, s) => accum + s, 0);
            var avg_score = sum / scores.length;

        }

        ctx.fillText(`Found: ${poses.length}, Score: ${pose ? min_score.toFixed(3) : ''}/${pose ? avg_score.toFixed(3) : ''}`, 40, 240);
        ctx.fillText(`Took ${took}ms which is ~ ${(1000 / took).toFixed(2)}fps`, 40, 200);

        // ctx.fillStyle = '#eee';
        // ctx.strokeStyle = '#eee';
        // draw pose results
        poses.forEach(debugPose)
        

       return poses;
    }
}

async function init(input) {
    console.log('video loaded!', input.videoWidth);
    // set up 
    overlay = document.getElementById('overlay');
    dpr = window.devicePixelRatio;
    width = input.videoWidth;
    height = input.videoHeight;
    input.width = width
    input.height = height
    overlay.width = width * dpr;
    overlay.height = height * dpr;
    overlay.style.width = width + 'px';
    overlay.style.height = height + 'px';
    console.log(input);
    ctx = overlay.getContext('2d');
    ctx.scale(dpr, dpr)
}

// draw lines
function drawLine(p1, p2) {
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
}

// draw landmarks
function debugPose(pose, i) {
    const keypoints = pose.keypoints;
    ctx.save();
    ctx.fillText(`Pose #${i} `, keypoints[0].x, keypoints[0].y - 50);
    ctx.restore();

    keypoints.forEach((e, i) => {
        ctx.beginPath();
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
        ctx.stroke();
    });

    BLAZE_POSE_INDICES.forEach(([a, b]) => {
        drawLine(keypoints[a], keypoints[b]);
    })
}

// BlazePose Keypoints: Used in MediaPipe BlazePose
// https://github.com/tensorflow/tfjs-models/tree/master/pose-detection
const NOSE = 0;
const LEFT_EYE_INNER = 1;
const LEFT_EYE = 2;
const LEFT_EYE_OUTER = 3;
const RIGHT_EYE_INNER = 4;
const RIGHT_EYE = 5;
const RIGHT_EYE_OUTER = 6;
const LEFT_EAR = 7;
const RIGHT_EAR = 8;
const MOUTH_LEFT = 9;
const MOUTH_RIGHT = 10;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;
const LEFT_ELBOW = 13;
const RIGHT_ELBOW = 14;
const LEFT_WRIST = 15;
const RIGHT_WRIST = 16;
const LEFT_PINKY = 17;
const RIGHT_PINKY = 18;
const LEFT_INDEX = 19;
const RIGHT_INDEX = 20;
const LEFT_THUMB = 21;
const RIGHT_THUMB = 22;
const LEFT_HIP = 23;
const RIGHT_HIP = 24;
const LEFT_KNEE = 25;
const RIGHT_KNEE = 26;
const LEFT_ANKLE = 27;
const RIGHT_ANKLE = 28;
const LEFT_HEEL = 29;
const RIGHT_HEEL = 30;
const LEFT_FOOT_INDEX = 31;
const RIGHT_FOOT_INDEX = 32;
const BODY_CENTER = 33;
const FORE_HEAD = 34;


const BLAZE_POSE_INDICES = [
    [LEFT_SHOULDER, RIGHT_SHOULDER],
    [LEFT_HIP, RIGHT_HIP],
    [RIGHT_SHOULDER, RIGHT_HIP],
    [RIGHT_HIP, RIGHT_KNEE],
    [RIGHT_KNEE, RIGHT_ANKLE],
    [RIGHT_ANKLE, RIGHT_HEEL],
    [RIGHT_HEEL, RIGHT_FOOT_INDEX],
    [LEFT_SHOULDER, LEFT_HIP],
    [LEFT_HIP, LEFT_KNEE],
    [LEFT_KNEE, LEFT_ANKLE],
    [LEFT_ANKLE, LEFT_HEEL],
    [LEFT_HEEL, LEFT_FOOT_INDEX],
    [LEFT_SHOULDER, LEFT_ELBOW],
    [LEFT_ELBOW, LEFT_WRIST],
    [LEFT_WRIST, LEFT_PINKY],
    [RIGHT_SHOULDER, RIGHT_ELBOW],
    [RIGHT_ELBOW, RIGHT_WRIST],
    [RIGHT_WRIST, RIGHT_PINKY],
    [RIGHT_PINKY, RIGHT_INDEX]
]