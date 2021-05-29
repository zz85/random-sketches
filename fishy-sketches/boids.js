"use strict";
// by twitter.com/blurspline | github.com/zz85
// see http://en.wikipedia.org/wiki/Flocking_(behavior)

var SPEED = 5;
var BIRDS = 50;
var FPS = 40;
var VISION = Math.PI * 0.15;

var w = 600, h = 600;

var c = document.createElement('canvas');
c.width = w;
c.height = h;

var mousex = 0 , mousey = 0, mousedown = -1;
c.addEventListener('mousemove', function(e) {
	mousex = e.clientX;
	mousey = e.clientY;
}, false);


function onmousedown(e) {
	mousedown = 1;
}

function onmouseup(e) {
	mousedown = -1;
}


c.addEventListener('mousedown', onmousedown, false);
c.addEventListener('mouseup', onmouseup, false);
window.addEventListener('keydown', onmousedown, false);
window.addEventListener('keyup', onmouseup, false);


document.body.appendChild(c);

var ctx = c.getContext('2d');

var flock = [];

var i, il, bird;
var rand = Math.random;


for (i=0;i<BIRDS;i++) {
	bird = {
		x: rand() * w,
		y: rand() * h,
		dx: (rand() - 0.5),
		dy: (rand() - 0.5)
	};
	flock.push(bird);
}


var dir, len,
dy, dx,
alignx, aligny, alignc,
cohesionx, cohesiony, cohesionc,
direction, j, bird2,
distx, disty, dist,
birdangle, diff,
avgdx, avgdy;


ctx.strokeStyle = 'blue';
ctx.fillStyle = 'yellow';

paint();

function paint() {
	setTimeout(paint, 1000/FPS);
	ctx.clearRect(0, 0, w, h);

	for (i=0;i<BIRDS;i++) {
		bird = flock[i];

		alignx = 0;
		aligny = 0;
		alignc = 0;
		cohesionx = 0;
		cohesiony = 0;
		cohesionc = 0;

		direction = Math.atan2(bird.dy, bird.dx);

		var mousedx = mousex - bird.x;
		var mousedy = mousey - bird.y;
		var mousedd = Math.sqrt(mousedx * mousedx + mousedy * mousedy);
		if (mousedd < 80) {
			bird.dx += mousedown * mousedx / mousedd;
			bird.dx *= 0.6;
			bird.dy += mousedown * mousedy / mousedd;
			bird.dy *= 0.6;
		}

		for (j=0;j<BIRDS;j++) {
			if (i==j) continue;
			bird2 = flock[j];
			distx = bird.x - bird2.x;
			disty = bird.y - bird2.y;
			dist = Math.sqrt(distx * distx + disty * disty);

			birdangle = Math.atan2(-disty, -distx);

			diff = birdangle - direction;
			if (diff > Math.PI) diff = 2 * Math.PI - diff;
			if (diff < -Math.PI) diff = -2 * Math.PI + diff;

			var affected = Math.abs(diff) <= VISION;

			if (dist <= 20) {
				// Separation - avoid crowding neighbors (short range repulsion)
				bird.dx += distx / dist;
				bird.dy += disty / dist;
				bird.dx /= 2;
				bird.dy /= 2;
			} else if (dist <= 50) {
				if (!affected) continue;
				// Alignment - steer towards average heading of neighbors
				alignx += bird2.dx;
				aligny += bird2.dy;
				alignc += 1;
			} else if (dist <= 100) {
				// Cohension steer towards average position of neighbors (long range attraction)
				if (!affected) continue;
				cohesionx += bird2.x;
				cohesiony += bird2.y;
				cohesionc += 1;
			}
		}


		if (alignc) {

			avgdx = alignx / alignc;
			avgdy = aligny / alignc;

			len = Math.sqrt(avgdx * avgdx + avgdy * avgdy);
			bird.dx = (bird.dx + avgdx / len) / 2;
			bird.dy = (bird.dy + avgdy / len) / 2;

		}


		if (cohesionc) {

			cohesionx = cohesionx / cohesionc;
			cohesiony = cohesiony / cohesionc;

			avgdx = cohesionx - bird.x;
			avgdy = cohesiony - bird.y;

			len = Math.sqrt(avgdx * avgdx + avgdy * avgdy);
			bird.dx = (bird.dx / 10 * 8 + avgdx / len / 10 * 2);
			bird.dy = (bird.dy / 10 * 8 + avgdy / len / 10 * 2);

		}

		if ((bird.x + bird.dx) < 0) bird.dx = -bird.dx;
		if ((bird.y + bird.dy) < 0) bird.dy = -bird.dy;
		if ((bird.x + bird.dx) > w) bird.dx = -bird.dx;
		if ((bird.y + bird.dy) > h) bird.dy = -bird.dy;

		bird.x += bird.dx * SPEED;
		bird.y += bird.dy * SPEED;


		len = Math.sqrt(bird.dx * bird.dx + bird.dy * bird.dy);
		dx = bird.dx / len;
		dy = bird.dy / len;

		// Draw creature

		ctx.beginPath();
		ctx.arc(bird.x, bird.y, 10, 0, Math.PI * 2, false);
		ctx.closePath();
		ctx.fillStyle = '#ffff60';
		ctx.fill();

		ctx.beginPath();

		var front_pos = 8,
		side_pos = 5;

		ctx.fillStyle = 'black';
		ctx.arc(bird.x + dx * front_pos - dy * side_pos, bird.y + dy * front_pos + dx * side_pos, 2, 0, Math.PI * 2, false);
		ctx.closePath();


		ctx.arc(bird.x + dx * front_pos + dy * side_pos, bird.y + dy * front_pos - dx * side_pos, 2, 0, Math.PI * 2, false);
		ctx.closePath();
		ctx.fill();


	}

}