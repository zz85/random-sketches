const { test, expect } = require("bun:test");
const CpuNumaVisualizer = require("./cpu-affinity-planner.js");

test("generateLayout creates correct CPU structure", () => {
    const visualizer = new CpuNumaVisualizer();
    const cpuData = visualizer.generateLayout(8, 2, 2);

    expect(cpuData).toHaveLength(8);
    expect(cpuData[0]).toEqual({
        id: 0,
        socket: 0,
        numa: 0,
        status: 'available',
        app: null,
        isHT: false
    });
    expect(cpuData[4]).toEqual({
        id: 4,
        socket: 0,
        numa: 0,
        status: 'available',
        app: null,
        isHT: true,
        sibling: 0
    });
    expect(visualizer.getNumaZones()).toHaveLength(2);
});

test("toggleCpuStatus cycles through states", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(4, 1, 1);

    let cpu = visualizer.toggleCpuStatus(0);
    expect(cpu.status).toBe('offline');

    cpu = visualizer.toggleCpuStatus(0);
    expect(cpu.status).toBe('reserved');

    cpu = visualizer.toggleCpuStatus(0);
    expect(cpu.status).toBe('available');
});

test("assignApp with balance strategy distributes across NUMA zones", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(8, 2, 2);

    visualizer.assignApp('nginx', 4, 'balance', 'start');

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    expect(assignedCpus).toHaveLength(4);

    const numa0Count = assignedCpus.filter(cpu => cpu.numa === 0).length;
    const numa1Count = assignedCpus.filter(cpu => cpu.numa === 1).length;
    expect(numa0Count).toBe(2);
    expect(numa1Count).toBe(2);
});

test("assignApp with fit strategy keeps within one NUMA zone", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(8, 2, 2);

    visualizer.assignApp('redis', 3, 'fit', 'start');

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'redis');
    expect(assignedCpus).toHaveLength(3);

    const numaIds = [...new Set(assignedCpus.map(cpu => cpu.numa))];
    expect(numaIds).toHaveLength(1);
});

test("assignApp assigns IRQ cores", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(8, 2, 2);

    visualizer.assignApp('irq', 4, 'balance', 'start');

    const irqAssigned = visualizer.getCpuData().filter(cpu => cpu.app === 'irq');
    expect(irqAssigned).toHaveLength(4);
    expect(visualizer.getAssignedApps().irq).toBe(4);
});

test("clearAll resets available cores", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(4, 1, 1);

    visualizer.assignApp('nginx', 2, 'balance', 'start');
    visualizer.clearAll();

    const availableCpus = visualizer.getCpuData().filter(cpu => cpu.status === 'available' && !cpu.app);
    expect(availableCpus).toHaveLength(4);
    expect(Object.keys(visualizer.getAssignedApps())).toHaveLength(0);
});

test("assignApp with siblings uses HT pairs", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(8, 2, 2);

    visualizer.assignApp('irq', 4, 'fit', 'start', true);

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'irq');
    expect(assignedCpus).toHaveLength(4);

    // Should have cores 0,4,1,5 (physical cores 0,1 with their HT siblings 4,5)
    const assignedIds = assignedCpus.map(cpu => cpu.id).sort((a, b) => a - b);
    expect(assignedIds).toEqual([0, 1, 4, 5]);
});

test("assignApp without siblings uses sequential cores", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(16, 2, 2); // 8 physical cores per NUMA

    visualizer.assignApp('nginx', 4, 'fit', 'start', false);

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    expect(assignedCpus).toHaveLength(4);

    // Should have cores 0,1,2,3 (sequential physical cores)
    const assignedIds = assignedCpus.map(cpu => cpu.id).sort((a, b) => a - b);
    expect(assignedIds).toEqual([0, 1, 2, 3]);
});

test("assignApp with siblings balances across NUMA zones", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(256, 2, 4); // 32 physical cores per NUMA

    visualizer.assignApp('nginx', 8, 'balance', 'start', true);

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    expect(assignedCpus).toHaveLength(8);

    // Should have cores 0,128,32,160,64,192,96,224 (one pair from each NUMA)
    const assignedIds = assignedCpus.map(cpu => cpu.id).sort((a, b) => a - b);
    expect(assignedIds).toEqual([0, 32, 64, 96, 128, 160, 192, 224]);
});

test("assignApp fit strategy respects starting NUMA zone", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(16, 2, 4); // 2 physical cores per NUMA

    // Fill NUMA 1 first, then move to NUMA 2
    visualizer.assignApp('nginx', 6, 'fit', 'start', false, 1);

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    expect(assignedCpus).toHaveLength(6);

    // Should fill NUMA 1 (cores 2,3,10,11) then NUMA 2 (cores 4,5)
    const assignedIds = assignedCpus.map(cpu => cpu.id).sort((a, b) => a - b);
    expect(assignedIds).toEqual([2, 3, 4, 5, 10, 11]);
});

test("parseNumaZoneList handles various formats", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(16, 2, 4);

    expect(visualizer.parseNumaZoneList("0-3")).toEqual([0, 1, 2, 3]);
    expect(visualizer.parseNumaZoneList("0,2")).toEqual([0, 2]);
    expect(visualizer.parseNumaZoneList("1,2,3")).toEqual([1, 2, 3]);
    expect(visualizer.parseNumaZoneList("")).toBe(null);
    expect(visualizer.parseNumaZoneList("0-1,3")).toEqual([0, 1, 3]);
});

test("assignApp balance respects NUMA zone list", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(16, 2, 4);

    // Balance across zones 0 and 2 only
    visualizer.assignApp('nginx', 4, 'balance', 'start', false, 0, [0, 2]);

    const assignedCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    expect(assignedCpus).toHaveLength(4);

    // Should only use NUMA zones 0 and 2
    const numaIds = [...new Set(assignedCpus.map(cpu => cpu.numa))];
    expect(numaIds.sort()).toEqual([0, 2]);
});

test("compressCoreList creates ranges correctly", () => {
    const visualizer = new CpuNumaVisualizer();

    expect(visualizer.compressCoreList([0, 1, 2, 4, 6, 7, 8])).toBe('0-2,4,6-8');
    expect(visualizer.compressCoreList([0, 32, 64, 96, 128, 160, 192, 224])).toBe('0,32,64,96,128,160,192,224');
    expect(visualizer.compressCoreList([0, 1, 32, 33, 64, 65, 96, 97])).toBe('0-1,32-33,64-65,96-97');
    expect(visualizer.compressCoreList([])).toBe('');
});

test("serializeAssignments creates correct format", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(16, 2, 4);

    visualizer.assignApp('nginx', 2, 'fit', 'start', false, 0);

    const serialized = visualizer.serializeAssignments();
    const config = JSON.parse(serialized);

    expect(config.cores).toBe(16);
    expect(config.sockets).toBe(2);
    expect(config.numa).toBe(4);
    expect(config.assignments.nginx).toBe('0-1');
});

test("deserializeAssignments restores configuration", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(8, 2, 2);

    const config = {
        cores: 8,
        sockets: 2,
        numa: 2,
        assignments: {
            nginx: '0-1',
            redis: '2'
        }
    };

    const success = visualizer.deserializeAssignments(JSON.stringify(config));
    expect(success).toBe(true);

    const nginxCores = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    const redisCores = visualizer.getCpuData().filter(cpu => cpu.app === 'redis');

    expect(nginxCores.map(cpu => cpu.id).sort()).toEqual([0, 1]);
    expect(redisCores.map(cpu => cpu.id)).toEqual([2]);
});

test("expandCoreList handles compressed ranges", () => {
    const visualizer = new CpuNumaVisualizer();

    expect(visualizer.expandCoreList('0-3')).toEqual([0, 1, 2, 3]);
    expect(visualizer.expandCoreList('0,2,4')).toEqual([0, 2, 4]);
    expect(visualizer.expandCoreList('0-1,3-4')).toEqual([0, 1, 3, 4]);
    expect(visualizer.expandCoreList('')).toEqual([]);
});

test("removeApp clears specific app assignment", () => {
    const visualizer = new CpuNumaVisualizer();
    visualizer.generateLayout(4, 1, 1);

    visualizer.assignApp('nginx', 2, 'balance', 'start');
    visualizer.assignApp('redis', 1, 'balance', 'start');

    visualizer.removeApp('nginx');

    const nginxCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'nginx');
    const redisCpus = visualizer.getCpuData().filter(cpu => cpu.app === 'redis');

    expect(nginxCpus).toHaveLength(0);
    expect(redisCpus).toHaveLength(1);
    expect(visualizer.getAssignedApps().nginx).toBeUndefined();
    expect(visualizer.getAssignedApps().redis).toBe(1);
});
