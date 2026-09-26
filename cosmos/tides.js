/*
 * tides.js - harmonic tide prediction in plain JavaScript.
 *
 * A port of the method in P. Schureman, "Manual of Harmonic Analysis and
 * Prediction of Tides" (US C&GS Special Publication 98, 1958), following the
 * structure of pytides (github.com/sam-cox/pytides) and XTide's congen.
 *
 *   h(t) = Z0 + sum_i  f_i(t) * H_i * cos( V_i(t) + u_i(t) - kappa_i )
 *
 *   H_i, kappa_i  amplitude and Greenwich epoch of constituent i (e.g. from
 *                 NOAA CO-OPS harcon.json: amplitude, phase_GMT)
 *   V_i(t)        equilibrium argument at Greenwich, from Doodson coefficients
 *                 applied to astronomical longitudes (Meeus polynomials)
 *   f_i, u_i      18.6 year nodal amplitude factor and phase correction
 *
 * Works as a browser global (window.Tides) or a CommonJS module.
 * Not for navigation.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Tides = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const D2R = Math.PI / 180, R2D = 180 / Math.PI;

    // ------------------------------------------------------------------
    // Astronomy (Meeus, Astronomical Algorithms) - same fits as pytides
    // ------------------------------------------------------------------
    function s2d(deg, min, sec) { return deg + (min || 0) / 60 + (sec || 0) / 3600; }
    function polyval(c, x) { let s = 0, p = 1; for (let i = 0; i < c.length; i++) { s += c[i] * p; p *= x; } return s; }
    function dpolyval(c, x) { let s = 0, p = 1; for (let i = 1; i < c.length; i++) { s += c[i] * i * p; p *= x; } return s; }
    function mod360(x) { x = x % 360; return x < 0 ? x + 360 : x; }

    function JD(date) { return date.getTime() / 86400000 + 2440587.5; }
    function julianCenturies(date) { return (JD(date) - 2451545.0) / 36525; }

    // Meeus 21.3, coefficients in U = T/100 rescaled to T
    const OBLIQUITY = [
        s2d(23, 26, 21.448), -s2d(0, 0, 4680.93), -s2d(0, 0, 1.55), s2d(0, 0, 1999.25),
        -s2d(0, 0, 51.38), -s2d(0, 0, 249.67), -s2d(0, 0, 39.05), s2d(0, 0, 7.12),
        s2d(0, 0, 27.87), s2d(0, 0, 5.79), s2d(0, 0, 2.45)
    ].map((c, i) => c * Math.pow(1e-2, i));

    const POLY = {
        s:     [218.3164591, 481267.88134236, -0.0013268, 1 / 538841.0 - 1 / 65194000.0], // lunar longitude, Meeus 45.1
        h:     [280.46645, 36000.76983, 0.0003032],                                           // solar longitude, Meeus 24.2
        p:     [83.3532430, 4069.0137111, -0.0103238, -1 / 80053.0, 1 / 18999000.0],         // lunar perigee
        N:     [125.0445550, -1934.1361849, 0.0020762, 1 / 467410.0, -1 / 60616000.0],       // lunar node, Meeus 45.7
        pp:    [280.46645 - 357.52910, 36000.76932 - 35999.05030, 0.0003032 + 0.0001559, 0.00000048], // solar perigee
        omega: OBLIQUITY,
        i:     [5.145]                                                                        // lunar inclination to ecliptic
    };
    const DT_DHOUR = 1 / (24 * 36525);

    // Schureman auxiliary angles (see notes on Table 6)
    function _I(N, i, omega) {
        const cosI = Math.cos(i) * Math.cos(omega) - Math.sin(i) * Math.sin(omega) * Math.cos(N);
        return Math.acos(cosI);
    }
    function _xiNu(N, i, omega) {
        let e1 = Math.atan(Math.cos(0.5 * (omega - i)) / Math.cos(0.5 * (omega + i)) * Math.tan(0.5 * N));
        let e2 = Math.atan(Math.sin(0.5 * (omega - i)) / Math.sin(0.5 * (omega + i)) * Math.tan(0.5 * N));
        e1 -= 0.5 * N; e2 -= 0.5 * N;
        return { xi: -(e1 + e2), nu: e1 - e2 };
    }
    function _nup(I, nu) { // Schureman 224
        return Math.atan(Math.sin(2 * I) * Math.sin(nu) / (Math.sin(2 * I) * Math.cos(nu) + 0.3347));
    }
    function _nupp(I, nu) { // Schureman 232
        const t = (Math.sin(I) ** 2 * Math.sin(2 * nu)) / (Math.sin(I) ** 2 * Math.cos(2 * nu) + 0.0727);
        return 0.5 * Math.atan(t);
    }

    /**
     * Astronomical state at a UTC date. All angles in degrees, speeds in deg/hour.
     * Basis for equilibrium arguments: [tau, s, h, p, N, pp, 90] where tau = T + h - s.
     */
    function astro(date) {
        const T = julianCenturies(date);
        const a = {};
        for (const k in POLY) {
            a[k] = mod360(polyval(POLY[k], T));
            a[k + '_speed'] = dpolyval(POLY[k], T) * DT_DHOUR;
        }
        // hour angle of mean sun at Greenwich: 180 deg at 0h UTC
        const jd = JD(date);
        a.T = (jd - Math.floor(jd)) * 360; a.T_speed = 15;
        a.tau = a.T + a.h - a.s; a.tau_speed = 15 + a.h_speed - a.s_speed;

        const N = a.N * D2R, i = a.i * D2R, omega = a.omega * D2R;
        const I = _I(N, i, omega);
        const { xi, nu } = _xiNu(N, i, omega);
        a.I = I * R2D; a.xi = mod360(xi * R2D); a.nu = mod360(nu * R2D);
        a.nup = mod360(_nup(I, nu) * R2D);
        a.nupp = mod360(_nupp(I, nu) * R2D);
        a.P = mod360(a.p - a.xi);
        return a;
    }

    const BASIS = ['tau', 's', 'h', 'p', 'N', 'pp'];
    function Vof(coef, a) {
        let v = coef[6] * 90;
        for (let k = 0; k < 6; k++) v += coef[k] * a[BASIS[k]];
        return v;
    }
    function speedOf(coef, a) {
        let v = 0;
        for (let k = 0; k < 6; k++) v += coef[k] * a[BASIS[k] + '_speed'];
        return v;
    }

    // ------------------------------------------------------------------
    // Node factors f and u (Schureman Table 2 / equations noted)
    // ------------------------------------------------------------------
    const F = {
        unity: () => 1,
        Mm(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;               // 73, 65
            return (2 / 3 - Math.sin(I) ** 2) / ((2 / 3 - Math.sin(w) ** 2) * (1 - 1.5 * Math.sin(i) ** 2)); },
        Mf(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;               // 74, 66
            return Math.sin(I) ** 2 / (Math.sin(w) ** 2 * Math.cos(0.5 * i) ** 4); },
        O1(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;               // 75, 67
            return (Math.sin(I) * Math.cos(0.5 * I) ** 2) / (Math.sin(w) * Math.cos(0.5 * w) ** 2 * Math.cos(0.5 * i) ** 4); },
        J1(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;               // 76, 68
            return Math.sin(2 * I) / (Math.sin(2 * w) * (1 - 1.5 * Math.sin(i) ** 2)); },
        OO1(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;              // 77, 69
            return Math.sin(I) * Math.sin(0.5 * I) ** 2 / (Math.sin(w) * Math.sin(0.5 * w) ** 2 * Math.cos(0.5 * i) ** 4); },
        M2(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R;               // 78, 70
            return Math.cos(0.5 * I) ** 4 / (Math.cos(0.5 * w) ** 4 * Math.cos(0.5 * i) ** 4); },
        K1(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R, nu = a.nu * D2R; // 227, 226, 68
            const mean = 0.5023 * Math.sin(2 * w) * (1 - 1.5 * Math.sin(i) ** 2) + 0.1681;
            return Math.sqrt(0.2523 * Math.sin(2 * I) ** 2 + 0.1689 * Math.sin(2 * I) * Math.cos(nu) + 0.0283) / mean; },
        L2(a) { const P = a.P * D2R, I = a.I * D2R;                                   // 215, 213, 204
            const Ra_inv = Math.sqrt(1 - 12 * Math.tan(0.5 * I) ** 2 * Math.cos(2 * P) + 36 * Math.tan(0.5 * I) ** 4);
            return F.M2(a) * Ra_inv; },
        K2(a) { const w = a.omega * D2R, i = a.i * D2R, I = a.I * D2R, nu = a.nu * D2R; // 235, 234, 71
            const mean = 0.5023 * Math.sin(w) ** 2 * (1 - 1.5 * Math.sin(i) ** 2) + 0.0365;
            return Math.sqrt(0.2523 * Math.sin(I) ** 4 + 0.0367 * Math.sin(I) ** 2 * Math.cos(2 * nu) + 0.0013) / mean; },
        M1(a) { const P = a.P * D2R, I = a.I * D2R;                                   // 206, 207, 195
            const Qa_inv = Math.sqrt(0.25 + 1.5 * Math.cos(I) * Math.cos(2 * P) * Math.cos(0.5 * I) ** -0.5 + 2.25 * Math.cos(I) ** 2 * Math.cos(0.5 * I) ** -4);
            return F.O1(a) * Qa_inv; },
        Modd: (n) => (a) => Math.pow(F.M2(a), n / 2)                                 // e.g. 149
    };
    const U = {
        zero: () => 0,
        Mf: (a) => -2 * a.xi,
        O1: (a) => 2 * a.xi - a.nu,
        J1: (a) => -a.nu,
        OO1: (a) => -2 * a.xi - a.nu,
        M2: (a) => 2 * a.xi - 2 * a.nu,
        K1: (a) => -a.nup,
        L2(a) { const I = a.I * D2R, P = a.P * D2R;                                   // 214
            const R = R2D * Math.atan(Math.sin(2 * P) / (1 / 6 * Math.tan(0.5 * I) ** -2 - Math.cos(2 * P)));
            return 2 * a.xi - 2 * a.nu - R; },
        K2: (a) => -2 * a.nupp,
        M1(a) { const I = a.I * D2R, P = a.P * D2R;                                   // 202
            const Q = R2D * Math.atan((5 * Math.cos(I) - 1) / (7 * Math.cos(I) + 1) * Math.tan(P));
            return a.xi - a.nu + Q; },
        Modd: (n) => (a) => n / 2 * U.M2(a)
    };

    // ------------------------------------------------------------------
    // Constituent table. XDO: Doodson-style letters for [tau s h p N pp 90],
    // A..Q = 1..17, Z = 0, Y..R = -1..-8  (as used by pytides / XTide congen)
    // ------------------------------------------------------------------
    const XDO_INT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12, M: 13, N: 14, O: 15, P: 16, Q: 17,
                      R: -8, S: -7, T: -6, U: -5, V: -4, W: -3, X: -2, Y: -1, Z: 0 };
    function xdo(str) { return str.replace(/\s/g, '').split('').map(c => XDO_INT[c.toUpperCase()]); }

    const C = {};
    function speciesOf(coef) {
        const n = Math.abs(coef[0]);
        return ['long', 'diurnal', 'semidiurnal', 'terdiurnal'][n] || 'shallow';
    }
    function base(name, xdoStr, u, f, extra) {
        const coef = xdo(xdoStr);
        C[name] = Object.assign({ name, coef, speedCoef: coef, u: u || U.zero, f: f || F.unity, species: speciesOf(coef), kind: 'base' }, extra || {});
        return C[name];
    }
    // compound: sum of n_k * member_k, f multiplies, u adds (Schureman ch. on shallow water constituents)
    function compound(name, members) {
        const coef = [0, 0, 0, 0, 0, 0, 0];
        for (const [m, n] of members) for (let k = 0; k < 7; k++) coef[k] += n * m.coef[k];
        C[name] = {
            name, coef, speedCoef: coef, species: speciesOf(coef), kind: 'compound',
            members: members.map(([m, n]) => [m.name, n]),
            u: (a) => members.reduce((s, [m, n]) => s + n * m.u(a), 0),
            f: (a) => members.reduce((s, [m, n]) => s * Math.pow(m.f(a), Math.abs(n)), 1)
        };
        return C[name];
    }

    // Definitions follow NOS/Schureman as encoded in XTide's congen_input.txt so that
    // NOAA published amplitudes/epochs are reproduced exactly.
    // Long period
    base('Z0',  'Z ZZZ ZZZ');
    base('Sa',  'Z ZAZ ZZZ');
    base('Ssa', 'Z ZBZ ZZZ');
    base('Mm',  'Z AZY ZZZ', U.zero, F.Mm);
    base('Mf',  'Z BZZ ZZZ', U.Mf, F.Mf);
    base('MSm', 'Z AXA ZZZ', U.zero, F.Mm);
    // Diurnal
    const Q1  = base('Q1',  'A XZA ZZA', U.O1, F.O1);
    const O1  = base('O1',  'A YZZ ZZA', U.O1, F.O1);
    const K1  = base('K1',  'A AZZ ZZY', U.K1, F.K1);
    const J1  = base('J1',  'A BZY ZZY', U.J1, F.J1);
    // M1 (NOS): V = tau + 90, u = xi - nu + Q where Q absorbs p (Schureman 126-127, Table 2 formula 2;
    // sign convention verified empirically against NOAA predictions). Its effective speed is that of
    // tau + p (14.4966939 deg/h), which is the speed NOAA publishes.
    base('M1',  'A ZZZ ZZA', U.M1, F.M1, { speedCoef: xdo('A ZZA ZZZ') });
    const P1  = base('P1',  'A AXZ ZZA');
    base('S1',  'A AYZ ZZZ');
    base('OO1', 'A CZZ ZZY', U.OO1, F.OO1);
    base('2Q1', 'A WZB ZZA', U.O1, F.O1);
    base('rho1', 'A XBY ZZA', U.O1, F.O1);
    base('sigma1', 'A WBZ ZZA', U.O1, F.O1);
    base('chi1',   'A ZBY ZZY', U.J1, F.J1);
    base('pi1',    'A AWZ ZAA');
    base('phi1',   'A ABZ ZZY');
    base('psi1',   'A AAZ ZYY');
    base('RP1',    'A AAZ ZYA');
    base('theta1', 'A BXA ZZY', U.J1, F.J1);
    base('MP1',    'A YBZ ZZY', U.J1, F.J1);
    base('SO1',    'A CXZ ZZY', U.J1, F.J1);
    base('TK1',    'A AWZ ZAA', (a) => a.nup, F.K1);
    // Semidiurnal
    const _2N2 = base('2N2', 'B XZB ZZZ', U.M2, F.M2);
    const N2   = base('N2',  'B YZA ZZZ', U.M2, F.M2);
    base('nu2', 'B YBY ZZZ', U.M2, F.M2);
    base('mu2', 'B XBZ ZZZ', U.M2, F.M2);
    const M2   = base('M2',  'B ZZZ ZZZ', U.M2, F.M2);
    base('lambda2', 'B AXA ZZB', U.M2, F.M2);
    const L2   = base('L2',  'B AZY ZZB', U.L2, F.L2);
    base('T2',  'B BWZ ZAZ');
    const S2   = base('S2',  'B BXZ ZZZ');
    base('R2',  'B BYZ ZYB');
    const K2   = base('K2',  'B BZZ ZZZ', U.K2, F.K2);
    base('KJ2', 'B CZY ZZB', (a) => -2 * a.nu, F.J1);   // KJ2-IHO (eta2) as in congen
    // Terdiurnal
    base('M3',  'C ZZZ ZZZ', U.Modd(3), F.Modd(3));
    base('S3',  'C CWZ ZZZ');

    // Compound (shallow water / interaction) constituents, as [member, multiplier]
    const COMPOUNDS = {
        MSF: [[S2, 1], [M2, -1]],
        KP1: [[K2, 1], [P1, -1]], NO1: [[N2, 1], [O1, -1]], '2PO1': [[P1, 2], [O1, -1]],
        OQ2: [[O1, 1], [Q1, 1]], OP2: [[O1, 1], [P1, 1]],
        eps2: [[M2, 1], [N2, 1], [S2, -1]], MKS2: [[M2, 1], [K2, 1], [S2, -1]], MSN2: [[M2, 1], [S2, 1], [N2, -1]],
        '2SM2': [[S2, 2], [M2, -1]], '2NS2': [[N2, 2], [S2, -1]], MLN2S2: [[M2, 1], [S2, -2], [N2, 1], [L2, 1]],
        '2ML2S2': [[M2, 2], [S2, -2], [L2, 1]], SKM2: [[S2, 1], [K2, 1], [M2, -1]], '2MS2K2': [[M2, 2], [S2, 1], [K2, -2]],
        MKL2S2: [[M2, 1], [S2, -2], [L2, 1], [K2, 1]], 'M2(KS)2': [[M2, 1], [S2, -2], [K2, 2]],
        '2SN(MK)2': [[S2, 2], [N2, 1], [M2, -1], [K2, -1]], '2KM(SN)2': [[K2, 2], [M2, 1], [S2, -1], [N2, -1]],
        MO3: [[M2, 1], [O1, 1]], NO3: [[N2, 1], [O1, 1]], '2MK3': [[M2, 2], [K1, -1]], SO3: [[S2, 1], [O1, 1]],
        MK3: [[M2, 1], [K1, 1]], SK3: [[S2, 1], [K1, 1]],
        MN4: [[M2, 1], [N2, 1]], M4: [[M2, 2]], SN4: [[S2, 1], [N2, 1]], MS4: [[M2, 1], [S2, 1]], MK4: [[M2, 1], [K2, 1]],
        S4: [[S2, 2]], SK4: [[S2, 1], [K2, 1]], '2MLS4': [[M2, 2], [S2, -1], [L2, 1]], ML4: [[M2, 1], [L2, 1]],
        N4: [[N2, 2]], SL4: [[S2, 1], [L2, 1]], '3MS4': [[M2, 3], [S2, -1]],
        MNO5: [[M2, 1], [N2, 1], [O1, 1]], '2MO5': [[M2, 2], [O1, 1]], '2MK5': [[M2, 2], [K1, 1]], MSK5: [[M2, 1], [S2, 1], [K1, 1]],
        '3KM5': [[K1, 1], [M2, 1], [K2, 1]], '2MP5': [[M2, 2], [P1, 1]], '3MP5': [[M2, 3], [P1, -1]], MNK5: [[M2, 1], [N2, 1], [K1, 1]],
        '2MN6': [[M2, 2], [N2, 1]], M6: [[M2, 3]], MSN6: [[M2, 1], [S2, 1], [N2, 1]], '2MS6': [[M2, 2], [S2, 1]],
        '2MK6': [[M2, 2], [K2, 1]], '2SM6': [[S2, 2], [M2, 1]], MSK6: [[M2, 1], [S2, 1], [K2, 1]], S6: [[S2, 3]],
        SNK6: [[S2, 1], [N2, 1], [K2, 1]], '2NMLS6': [[N2, 2], [M2, 1], [L2, 1], [S2, -1]], '2NM6': [[N2, 2], [M2, 1]],
        MSL6: [[M2, 1], [S2, 1], [L2, 1]], '2ML6': [[M2, 2], [L2, 1]], '2MNLS6': [[M2, 2], [N2, 1], [L2, 1], [S2, -1]],
        '3MLS6': [[M2, 3], [L2, 1], [S2, -1]], '2MLNS6': [[M2, 2], [L2, 1], [N2, 1], [S2, -1]],
        '3MK7': [[M2, 3], [K1, -1]], '2MNO7': [[M2, 2], [N2, 1], [O1, 1]], '2NMK7': [[N2, 2], [M2, 1], [K1, 1]],
        '2MSO7': [[M2, 2], [S2, 1], [O1, 1]], MSKO7: [[M2, 1], [S2, 1], [K2, 1], [O1, 1]],
        M8: [[M2, 4]], '3MS8': [[M2, 3], [S2, 1]], '2MSN8': [[M2, 2], [S2, 1], [N2, 1]], '2(MS)8': [[M2, 2], [S2, 2]],
        '2(MN)8': [[M2, 2], [N2, 2]], '2MSL8': [[M2, 2], [S2, 1], [L2, 1]], '4MLS8': [[M2, 4], [L2, 1], [S2, -1]],
        '3ML8': [[M2, 3], [L2, 1]], '3MN8': [[M2, 3], [N2, 1]], '3MK8': [[M2, 3], [K2, 1]], '2MSK8': [[M2, 2], [S2, 1], [K2, 1]],
        '2M2NK9': [[M2, 2], [N2, 2], [K1, 1]], '3MNK9': [[M2, 3], [N2, 1], [K1, 1]], '4MK9': [[M2, 4], [K1, 1]], '3MSK9': [[M2, 3], [S2, 1], [K1, 1]],
        M10: [[M2, 5]], '4MN10': [[M2, 4], [N2, 1]], '3MNS10': [[M2, 3], [N2, 1], [S2, 1]], '4MS10': [[M2, 4], [S2, 1]],
        '3MSL10': [[M2, 3], [S2, 1], [L2, 1]], '3M2S10': [[M2, 3], [S2, 2]],
        '4MSK11': [[M2, 4], [S2, 1], [K1, 1]],
        M12: [[M2, 6]], '4MNS12': [[M2, 4], [N2, 1], [S2, 1]], '5MS12': [[M2, 5], [S2, 1]], '4MSL12': [[M2, 4], [S2, 1], [L2, 1]], '4M2S12': [[M2, 4], [S2, 2]]
    };
    for (const k in COMPOUNDS) compound(k, COMPOUNDS[k]);

    // Names as used by NOAA CO-OPS harcon.json (uppercase, parentheses stripped) -> table key
    const ALIASES = {
        LAM2: 'lambda2', LAMBDA2: 'lambda2', NU2: 'nu2', MU2: 'mu2', '2MS2': 'mu2', RHO: 'rho1', RHO1: 'rho1',
        SIGMA1: 'sigma1', SIG1: 'sigma1', CHI1: 'chi1', PI1: 'pi1', PHI1: 'phi1', PSI1: 'psi1', THETA1: 'theta1', THE1: 'theta1',
        EPS2: 'eps2', MNS2: 'eps2', ETA2: 'KJ2', SSA: 'Ssa', SA: 'Sa', MM: 'Mm', MF: 'Mf', MSM: 'MSm',
        OO2: 'OQ2', M2KS2: 'M2(KS)2', '2SNMK2': '2SN(MK)2', '2KMSN2': '2KM(SN)2', '2MS8': '2(MS)8', '2MN8': '2(MN)8'
    };
    function resolve(name) {
        if (C[name]) return C[name];
        const up = String(name).toUpperCase().replace(/\s/g, '');
        if (ALIASES[up]) return C[ALIASES[up]];
        for (const k in C) if (k.toUpperCase() === up) return C[k];
        return null;
    }

    // ------------------------------------------------------------------
    // Prediction
    // ------------------------------------------------------------------
    /**
     * Build a "model" from constituent records:
     *   [{name:'M2', amplitude:3.487, phase:10.8, speed?:28.984104}, ...]
     * phase = Greenwich epoch (kappa) in degrees; amplitude in any unit.
     * Returns {constituents:[{name, amplitude, phase, def, speed, speedNOAA}], unknown:[...], offset}
     */
    function model(records, opts) {
        opts = opts || {};
        const a0 = astro(new Date());
        const used = [], unknown = [];
        for (const r of records) {
            const amp = +r.amplitude;
            if (!(amp > 0)) continue;
            const def = resolve(r.name);
            if (!def) { unknown.push({ name: r.name, amplitude: amp, phase: +r.phase }); continue; }
            const speed = speedOf(def.speedCoef, a0);
            const rec = { name: r.name, key: def.name, amplitude: amp, phase: +r.phase, def, speed, species: def.species };
            if (r.speed != null) {
                rec.speedNOAA = +r.speed;
                // sanity: a constituent whose Doodson numbers do not reproduce the published speed is a mistake in the table
                if (Math.abs(rec.speedNOAA - speed) > 1e-3) { rec.speedMismatch = true; unknown.push({ name: r.name, amplitude: amp, phase: +r.phase, reason: 'speed mismatch ' + speed.toFixed(6) + ' vs ' + rec.speedNOAA }); continue; }
            }
            used.push(rec);
        }
        used.sort((x, y) => y.amplitude - x.amplitude);
        return { constituents: used, unknown, offset: opts.offset || 0, units: opts.units || '', name: opts.name || '' };
    }

    /** Per-constituent terms at a date: [{name, amplitude, f, u, V, arg, value}] */
    function terms(m, date) {
        const a = astro(date);
        return m.constituents.map(c => {
            const f = c.def.f(a), u = c.def.u(a), V = Vof(c.def.coef, a);
            const arg = (V + u - c.phase) * D2R;
            return { name: c.name, key: c.key, amplitude: c.amplitude, species: c.species, f, u, V: mod360(V), arg, value: f * c.amplitude * Math.cos(arg) };
        });
    }

    /** Height at a date (same units as amplitudes, relative to m.offset datum) */
    function height(m, date) {
        const a = astro(date);
        let h = m.offset;
        for (const c of m.constituents) {
            h += c.def.f(a) * c.amplitude * Math.cos((Vof(c.def.coef, a) + c.def.u(a) - c.phase) * D2R);
        }
        return h;
    }

    /**
     * Fast series: nodal factors f,u and V0 evaluated once at the series
     * midpoint, then V advanced linearly by constituent speed (this is how
     * tide tables are computed; f,u change negligibly within a month).
     * Returns {times:[ms], heights:[]}
     */
    function series(m, start, end, stepMinutes) {
        const stepMs = (stepMinutes || 6) * 60000;
        const t0 = start.getTime(), t1 = end.getTime();
        const mid = new Date((t0 + t1) / 2);
        const a = astro(mid);
        const pre = m.constituents.map(c => ({
            amp: c.def.f(a) * c.amplitude,
            phase0: (Vof(c.def.coef, a) + c.def.u(a) - c.phase) * D2R,
            w: speedOf(c.def.speedCoef, a) * D2R / 3600000  // rad per ms
        }));
        const n = Math.floor((t1 - t0) / stepMs) + 1;
        const times = new Array(n), heights = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            const t = t0 + k * stepMs, dt = t - mid.getTime();
            let h = m.offset;
            for (let j = 0; j < pre.length; j++) h += pre[j].amp * Math.cos(pre[j].phase0 + pre[j].w * dt);
            times[k] = t; heights[k] = h;
        }
        return { times, heights, stepMs };
    }

    /**
     * High/low water between start and end.
     * Returns [{time:Date, height, type:'H'|'L'}]
     */
    function extremes(m, start, end) {
        const coarse = 10; // minutes
        const pad = 2 * 60 * 60000;
        const s = series(m, new Date(start.getTime() - pad), new Date(end.getTime() + pad), coarse);
        const out = [];
        const H = s.heights, T = s.times;
        for (let k = 1; k < H.length - 1; k++) {
            const isMax = H[k] > H[k - 1] && H[k] >= H[k + 1];
            const isMin = H[k] < H[k - 1] && H[k] <= H[k + 1];
            if (!isMax && !isMin) continue;
            // refine by golden-section search on [T[k-1], T[k+1]] using exact height()
            let lo = T[k - 1], hi = T[k + 1];
            const g = (Math.sqrt(5) - 1) / 2;
            let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
            let f1 = height(m, new Date(x1)), f2 = height(m, new Date(x2));
            const better = isMax ? (p, q) => p > q : (p, q) => p < q;
            for (let it = 0; it < 30 && hi - lo > 2000; it++) {
                if (better(f1, f2)) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = height(m, new Date(x1)); }
                else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = height(m, new Date(x2)); }
            }
            const tm = (lo + hi) / 2;
            if (tm < start.getTime() || tm > end.getTime()) continue;
            out.push({ time: new Date(tm), height: height(m, new Date(tm)), type: isMax ? 'H' : 'L' });
        }
        return out;
    }

    /** Summed amplitude by species, and form number F = (K1+O1)/(M2+S2) */
    function stats(m) {
        const bySpecies = {};
        const byName = {};
        for (const c of m.constituents) {
            bySpecies[c.species] = (bySpecies[c.species] || 0) + c.amplitude;
            byName[c.key] = c.amplitude;
        }
        const F_ = ((byName.K1 || 0) + (byName.O1 || 0)) / (((byName.M2 || 0) + (byName.S2 || 0)) || 1e-9);
        let type = 'semidiurnal';
        if (F_ > 3) type = 'diurnal'; else if (F_ > 1.5) type = 'mixed, mainly diurnal'; else if (F_ > 0.25) type = 'mixed, mainly semidiurnal';
        return { bySpecies, formNumber: F_, type };
    }

    // ------------------------------------------------------------------
    // NOAA CO-OPS helpers
    // ------------------------------------------------------------------
    const NOAA = {
        mdapi: 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/',
        data: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
        /** Convert harcon.json + datums.json into a model relative to `datum` (default MLLW) */
        toModel(station, harcon, datums, datum) {
            datum = datum || 'MLLW';
            const dv = {};
            for (const d of (datums && datums.datums) || []) dv[d.name] = d.value;
            // harmonic amplitudes are about MSL (Z0); shift so heights are relative to requested datum
            let offset = 0;
            if (dv.MSL != null && dv[datum] != null) offset = dv.MSL - dv[datum];
            const recs = harcon.HarmonicConstituents.map(c => ({ name: c.name, amplitude: c.amplitude, phase: c.phase_GMT, speed: c.speed, description: c.description }));
            const m = model(recs, { offset, units: harcon.units, name: station && station.name });
            m.datum = datum; m.datums = dv; m.station = station;
            return m;
        },
        async fetchStation(id) {
            const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' -> ' + r.status); return r.json(); };
            const [st, hc, dt] = await Promise.all([
                j(NOAA.mdapi + id + '.json'), j(NOAA.mdapi + id + '/harcon.json'), j(NOAA.mdapi + id + '/datums.json')
            ]);
            const s = st.stations && st.stations[0];
            return { station: { id, name: s && s.name, state: s && s.state, lat: s && s.lat, lng: s && s.lng, tz: s && s.timezonecorr }, harcon: hc, datums: dt };
        },
        /** Official NOAA predictions (feet, GMT) for overlay/validation. interval: 6|60|'hilo' */
        async fetchPredictions(id, begin, end, opts) {
            opts = opts || {};
            const yyyymmdd = d => d.toISOString().slice(0, 10).replace(/-/g, '') + ' ' + d.toISOString().slice(11, 16);
            const q = new URLSearchParams({
                product: 'predictions', station: id, begin_date: yyyymmdd(begin), end_date: yyyymmdd(end),
                datum: opts.datum || 'MLLW', units: opts.units === 'meters' ? 'metric' : 'english', time_zone: 'gmt', format: 'json',
                interval: String(opts.interval || 6)
            });
            const r = await fetch(NOAA.data + '?' + q.toString());
            if (!r.ok) throw new Error('NOAA predictions ' + r.status);
            const j = await r.json();
            if (!j.predictions) throw new Error((j.error && j.error.message) || 'no predictions');
            return j.predictions.map(p => ({ time: new Date(p.t.replace(' ', 'T') + 'Z'), height: +p.v, type: p.type }));
        }
    };

    return {
        astro, model, terms, height, series, extremes, stats, resolve, constituents: C, NOAA,
        JD, speedOf: (name) => { const d = resolve(name); return d ? speedOf(d.speedCoef, astro(new Date())) : NaN; },
        V: (name, date) => { const d = resolve(name); return d ? mod360(Vof(d.coef, astro(date))) : NaN; }
    };
}));
