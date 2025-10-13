class CpuNumaVisualizer {
    constructor() {
        this.cpuData = [];
        this.numaZones = [];
        this.assignedApps = {};
    }

    generateLayout(cores, sockets, numa) {
        this.cpuData = [];
        this.numaZones = [];
        this.assignedApps = {};

        const physicalCores = cores / 2; // Assuming hyperthreading
        const physicalCoresPerNuma = Math.ceil(physicalCores / numa);
        const coresPerSocket = Math.ceil(cores / sockets);

        // Create physical cores first (0 to physicalCores-1)
        for (let i = 0; i < physicalCores; i++) {
            this.cpuData.push({
                id: i,
                socket: Math.floor(i / (coresPerSocket / 2)),
                numa: Math.floor(i / physicalCoresPerNuma),
                status: 'available',
                app: null,
                isHT: false
            });
        }

        // Create hyperthreaded siblings (physicalCores to cores-1)
        for (let i = 0; i < physicalCores; i++) {
            this.cpuData.push({
                id: i + physicalCores,
                socket: Math.floor(i / (coresPerSocket / 2)),
                numa: Math.floor(i / physicalCoresPerNuma),
                status: 'available',
                app: null,
                isHT: true,
                sibling: i
            });
        }

        // Group by NUMA zones
        for (let n = 0; n < numa; n++) {
            this.numaZones[n] = this.cpuData.filter(cpu => cpu.numa === n);
        }

        return this.cpuData;
    }

    toggleCpuStatus(cpuId) {
        const cpu = this.cpuData[cpuId];
        if (cpu.status === 'available') {
            cpu.status = 'offline';
            cpu.app = null;
        } else if (cpu.status === 'offline') {
            cpu.status = 'reserved';
        } else {
            cpu.status = 'available';
            cpu.app = null;
        }
        return cpu;
    }

    assignApp(appName, appCores, strategy, allocOrder, useSiblings = false, startingNuma = 0, numaZoneList = null) {
        if (appCores === 0) return false;

        this.cpuData.forEach(cpu => {
            if (cpu.app === appName) {
                cpu.app = null;
                if (cpu.status !== 'offline' && cpu.status !== 'reserved') {
                    cpu.status = 'available';
                }
            }
        });

        const availableCpus = this.cpuData.filter(cpu => cpu.status === 'available' && !cpu.app);

        if (useSiblings) {
            return this._assignWithSiblings(appName, appCores, strategy, allocOrder, availableCpus, startingNuma, numaZoneList);
        }

        if (strategy === 'balance') {
            const zones = numaZoneList || Array.from({length: this.numaZones.length}, (_, i) => i);
            let assigned = 0;
            let zoneIndex = 0;

            while (assigned < appCores && assigned < availableCpus.length) {
                const numaId = zones[zoneIndex];
                const numaAvailable = availableCpus.filter(cpu => cpu.numa === numaId && !cpu.app);
                if (allocOrder === 'end') numaAvailable.reverse();

                // Prefer physical cores first when not using siblings
                const sortedCpus = numaAvailable.sort((a, b) => a.isHT - b.isHT);

                if (sortedCpus.length > 0) {
                    sortedCpus[0].app = appName;
                    assigned++;
                }
                zoneIndex = (zoneIndex + 1) % zones.length;
            }
        } else {
            let assigned = 0;
            for (let i = 0; i < this.numaZones.length && assigned < appCores; i++) {
                const numaId = (startingNuma + i) % this.numaZones.length;
                const numaAvailable = availableCpus.filter(cpu => cpu.numa === numaId && !cpu.app);
                if (allocOrder === 'end') numaAvailable.reverse();

                // Prefer physical cores first when not using siblings
                const sortedCpus = numaAvailable.sort((a, b) => a.isHT - b.isHT);

                const toAssign = Math.min(appCores - assigned, sortedCpus.length);
                for (let j = 0; j < toAssign; j++) {
                    sortedCpus[j].app = appName;
                    assigned++;
                }
            }
        }

        this.assignedApps[appName] = appCores;
        return true;
    }

    _assignWithSiblings(appName, appCores, strategy, allocOrder, availableCpus, startingNuma = 0, numaZoneList = null) {
        if (strategy === 'balance') {
            const zones = numaZoneList || Array.from({length: this.numaZones.length}, (_, i) => i);
            let assigned = 0;
            let zoneIndex = 0;

            while (assigned < appCores) {
                const numaId = zones[zoneIndex];
                const numaAvailable = availableCpus.filter(cpu => cpu.numa === numaId && !cpu.app && !cpu.isHT);
                if (allocOrder === 'end') numaAvailable.reverse();

                if (numaAvailable.length > 0) {
                    const physCore = numaAvailable[0];
                    const sibling = this.cpuData.find(cpu => cpu.isHT && cpu.sibling === physCore.id && cpu.status === 'available' && !cpu.app);

                    physCore.app = appName;
                    assigned++;

                    if (assigned < appCores && sibling) {
                        sibling.app = appName;
                        assigned++;
                    }
                }
                zoneIndex = (zoneIndex + 1) % zones.length;
            }
        } else {
            let assigned = 0;
            for (let i = 0; i < this.numaZones.length && assigned < appCores; i++) {
                const numaId = (startingNuma + i) % this.numaZones.length;
                const numaPhysical = availableCpus.filter(cpu => cpu.numa === numaId && !cpu.app && !cpu.isHT);
                if (allocOrder === 'end') numaPhysical.reverse();

                for (const physCore of numaPhysical) {
                    if (assigned >= appCores) break;
                    const sibling = this.cpuData.find(cpu => cpu.isHT && cpu.sibling === physCore.id && cpu.status === 'available' && !cpu.app);

                    physCore.app = appName;
                    assigned++;

                    if (assigned < appCores && sibling) {
                        sibling.app = appName;
                        assigned++;
                    }
                }
            }
        }

        this.assignedApps[appName] = appCores;
        return true;
    }

    clearAll() {
        this.cpuData.forEach(cpu => {
            if (cpu.status !== 'offline' && cpu.status !== 'reserved') {
                cpu.status = 'available';
                cpu.app = null;
            }
        });
        this.assignedApps = {};
    }

    removeApp(appName) {
        this.cpuData.forEach(cpu => {
            if (cpu.app === appName) {
                cpu.app = null;
            }
        });
        delete this.assignedApps[appName];
    }

    getCpuData() {
        return this.cpuData;
    }

    getNumaZones() {
        return this.numaZones;
    }

    getAssignedApps() {
        return this.assignedApps;
    }

    compressCoreList(coreIds) {
        if (coreIds.length === 0) return '';

        const sorted = [...coreIds].sort((a, b) => a - b);
        const ranges = [];
        let start = sorted[0];
        let end = sorted[0];

        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `${start}` : `${start}-${end}`);
                start = end = sorted[i];
            }
        }
        ranges.push(start === end ? `${start}` : `${start}-${end}`);

        return ranges.join(',');
    }

    getAppCoreList(appName) {
        const cores = this.cpuData.filter(cpu => cpu.app === appName).map(cpu => cpu.id);
        return this.compressCoreList(cores);
    }

    getAppNumaList(appName) {
        const numaZones = [...new Set(this.cpuData.filter(cpu => cpu.app === appName).map(cpu => cpu.numa))];
        return this.compressCoreList(numaZones.sort((a, b) => a - b));
    }

    serializeAssignments() {
        const config = {
            cores: this.cpuData.length,
            sockets: Math.max(...this.cpuData.map(cpu => cpu.socket)) + 1,
            numa: this.numaZones.length,
            assignments: {}
        };

        Object.keys(this.assignedApps).forEach(app => {
            const coreIds = this.cpuData.filter(cpu => cpu.app === app).map(cpu => cpu.id);
            config.assignments[app] = this.compressCoreList(coreIds);
        });

        return JSON.stringify(config);
    }

    deserializeAssignments(serializedData) {
        try {
            const config = JSON.parse(serializedData);

            // Regenerate layout if system config differs
            if (config.cores !== this.cpuData.length || config.numa !== this.numaZones.length) {
                this.generateLayout(config.cores, config.sockets, config.numa);
            } else {
                this.clearAll();
            }

            Object.entries(config.assignments).forEach(([app, compressedCores]) => {
                const coreIds = this.expandCoreList(compressedCores);
                coreIds.forEach(coreId => {
                    const cpu = this.cpuData[coreId];
                    if (cpu && cpu.status === 'available') {
                        cpu.app = app;
                    }
                });
                this.assignedApps[app] = coreIds.length;
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    expandCoreList(compressedList) {
        if (!compressedList) return [];

        const cores = [];
        const ranges = compressedList.split(',');

        for (const range of ranges) {
            if (range.includes('-')) {
                const [start, end] = range.split('-').map(n => parseInt(n));
                for (let i = start; i <= end; i++) {
                    cores.push(i);
                }
            } else {
                cores.push(parseInt(range));
            }
        }

        return cores;
    }

    parseNumaZoneList(zoneListStr) {
        if (!zoneListStr || zoneListStr.trim() === '') return null;

        const zones = [];
        const parts = zoneListStr.split(',');

        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.includes('-')) {
                const [start, end] = trimmed.split('-').map(n => parseInt(n.trim()));
                for (let i = start; i <= end; i++) {
                    zones.push(i);
                }
            } else {
                zones.push(parseInt(trimmed));
            }
        }

        return zones.filter(z => z >= 0 && z < this.numaZones.length);
    }
}

// Export for Node.js/Bun.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CpuNumaVisualizer;
}

// Make available globally for browser
if (typeof window !== 'undefined') {
    window.CpuNumaVisualizer = CpuNumaVisualizer;
}
