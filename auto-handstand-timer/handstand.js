
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
        return "Heads needs to be below shoulders"
    }

    // without this headstand becomes legit
    if (isAboveCheck(keypoints, LEFT_SHOULDER, LEFT_WRIST) ||
        isAboveCheck(keypoints, RIGHT_SHOULDER, RIGHT_WRIST)
    ) {
        return "Shoulders needs to be above wrists"
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
