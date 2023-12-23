var lastLapsed;

async function loadModel() {
    start = Date.now()
    // Create a detector.
    const model = poseDetection.SupportedModels.BlazePose;
    const detectorConfig = {
        runtime: 'mediapipe',
        modelType: 'lite', //  'lite', 'full', 'heavy'
        enableSegmentation: false,
        solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose'
                    // or 'base/node_modules/@mediapipe/pose' in npm.
    };
    
    try {
        detector = await poseDetection.createDetector(model, detectorConfig);
    } catch(e) {
        console.error(e)
    }

    console.log('Model took', Date.now() - start, 'ms')
    return detector
}

// processing loop
async function process() {
    start = Date.now();
    const estimationConfig = {enableSmoothing: true};
    // const poses = await detector.estimatePoses(image, estimationConfig);
    poses = await detector.estimatePoses(input, estimationConfig);

    took = Date.now() - start;

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
    ctx.fillText(`Found: ${poses.length}, Score: ${pose ? min_score.toFixed(3): ''}/${pose ? avg_score.toFixed(3): ''}`, 40, 240);
    took = Date.now() - start;
    ctx.fillText(`Took ${took}ms which is ~ ${(1000 / took).toFixed(2)}fps`, 40, 200);

    if (poses[0]) {
        let why = didntHandstand(poses[0])

        var lapsed = handstandTracker.update(!why, input.currentTime, poses[0]);
        if (lapsed) {
            lastLapsed = lapsed
        }

        ctx.save();
        ctx.font = `bold ${why ? 10: 24 }px serif`;
        ctx.fillStyle = why ? 'red' : 'green';
        ctx.fillText(why ? why : 'Handstand!', 50, 300);

        if (lastLapsed) {
            ctx.fillText(lastLapsed.toFixed(2) + 's', 50, 100);
        }

        ctx.restore();
    }

    // draw pose results
    poses.forEach(debugPose)

    setTimeout(process, 5)
}

function run() {
    input.play()
    process()
}

async function init(input) {
    console.log('video loaded!', input.videoWidth);
    // set up 
    overlay = document.getElementById('overlay');
    dpr = window.devicePixelRatio;
    // dpr = 1;
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
    keypoints = pose.keypoints;
    ctx.save();
    ctx.fillStyle = 'yellow'
    ctx.fillText(`Pose #${i} `, keypoints[0].x, keypoints[0].y - 50);
    ctx.restore();

    ctx.strokeStyle = 'white';

    keypoints.forEach((e, i) => {
        ctx.beginPath();
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
        ctx.stroke();
        // ctx.fillText(`${i}: ${e.part}`, e.x | 0, e.y | 0);
    })

    // left hip -> left knee -> left ankle
    // drawLine(keypoints[11], keypoints[13]);

    drawLine(keypoints[11], keypoints[12]);
    [
        [23, 24],
        [12, 24],
        [24, 26],
        [26, 28],
        [28, 30],
        [30, 32],
        [11, 23],
        [23, 25],
        [25, 27],
        [27, 29],
        [29, 31],
        [11, 13],
        [13, 15],
        [15, 17],

        [12, 14],
        [14, 16],
        [16, 18],
        [18, 20],
].forEach(([a, b]) => {
    drawLine(keypoints[a], keypoints[b]);
})





    drawLine(keypoints[11], keypoints[12]);
    


    // keypoints
    /*

    Id	Part
    0	nose
    1	leftEye
    2	rightEye
    3	leftEar
    4	rightEar
    5	leftShoulder
    6	rightShoulder
    7	leftElbow
    8	rightElbow
    9	leftWrist
    10	rightWrist
    11	leftHip
    12	rightHip
    13	leftKnee
    14	rightKnee
    15	leftAnkle
    16	rightAnkles
    */
}