
function isAbove(keypoints, candidate, reference) {
    return keypoints[candidate].y < keypoints[reference].y;
}

// Note: we return true when the condition is not matched!
function isAboveCheck(keypoints, candidate, reference) {
    return !isAbove(keypoints, candidate, reference);
}

// min time of 0.5s;
const MIN_THRESHOLD = 0.5;

class HandstandTracker {
    constructor() {
        this.lastTime = 0;
        this.running = false;
        this.started = 0;
        this.tracker = [
            // format in { started, duration }
        ];

        this.points = [];
    }

    update(inPosition, time, poses) {
        if (inPosition) {
            this.points.push(poses);
            return this.inPosition(time);
        } else {
            if (this.running) {
                // stop
                const duration = time - this.started;

                // check threshold
                if (duration > MIN_THRESHOLD) {
                    this.tracker.push({
                        started: this.started,
                        duration,
                        points: this.points
                    });
                }
                this.points = [];
            }
            this.running = false;
        }
    }

    inPosition(time) {
        if (!this.running) {
            this.running = true;
            this.started = time;
        }

        this.lastTime = time;
        var lapsed = time - this.started;
        if (lapsed > MIN_THRESHOLD) {
            return lapsed;
        }
        
    }

}

function didntHandstand(pose) {
    const { keypoints, keypoints3D } = pose;

    // TODO check confidence, or event bounding box

    // Rules

    // 1. shoulders above head
    if (isAboveCheck(keypoints, LEFT_SHOULDER, NOSE) ||
        isAboveCheck(keypoints, RIGHT_SHOULDER, NOSE)
    ) {
        return "Head needs to be above shoulders"
    }

    // 2. hips above shoulders
    if (isAboveCheck(keypoints, LEFT_HIP, LEFT_SHOULDER) ||
        isAboveCheck(keypoints, RIGHT_HIP, RIGHT_SHOULDER)
    ) {
        return "Hips needs to be above shoulders"
    }

    // Check that heels is above floor, aka above wrist
    if (isAboveCheck(keypoints, LEFT_HEEL, LEFT_WRIST) ||
        isAboveCheck(keypoints, RIGHT_HEEL, RIGHT_WRIST)
    ) {
        return "Heels needs to be off the floor"
    }

    // for more confidence and less false positives
    if (isAboveCheck(keypoints, LEFT_HEEL, LEFT_ELBOW) ||
        isAboveCheck(keypoints, RIGHT_HEEL, RIGHT_ELBOW)
    ) {
        return "Heels needs to be above elbows"
    }
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
