const missedConnections = {
    initialized: false,
    _tickTimeout: null,
    visible: false,

    // Store map reference
    map: null,

    // Keep track of our GeoJSON data globally
    geojson: {
        type: "FeatureCollection",
        features: []
    },

    init() {
        if (this.initialized) return;
        this.initialized = true;

        const api = window.SubwayBuilderAPI;

        // Hook into game state changes to check tracks
        const hooksToRegister = [
            'onTrackChange',
            'onGameLoaded'
        ];

        hooksToRegister.forEach(hookName => {
            api.hooks[hookName]((...args) => {
                this.queueCheckTracks();
            });
        });

        api.hooks.onMapReady((mapInstance) => {
            this.map = mapInstance;
            this.setupButton();
            this.setupMapLayers();
            this.queueCheckTracks();
        });
    },
    
    /**
     * Set up button at the top UI bar.
     */
    setupButton() {
        window.SubwayBuilderAPI.ui.addToolbarButton({
            id: "missed-connections-button",
            tooltip: "Missed Connections",
            icon: "Cable",
            onClick: () => {
                this.visible = !this.visible;
                this.toggleVisibility();
            },
            isActive: () => this.visible
        });
    },

    /**
     * Set up Mapbox layers and sources.
     */
    setupMapLayers() {
        const api = window.SubwayBuilderAPI;
        const map = this.map;

        if (!map) return;
        
        const OPACITY = 0.95;

        const MIN_ZOOM = 9;         // Zoom level at which icons reach their smallest size
        const MAX_ZOOM = 13;        // Zoom level at which icons reach their largest size

        const MIN_SCALE = 0.1;     // Smallest scale factor (at MIN_ZOOM or below)
        const MAX_SCALE = 0.6;      // Largest scale factor (at MAX_ZOOM or above)

        window.addEventListener("keydown", (event) => {
            if (event.repeat) return;
            
            if (event.key === "~" || event.key === "`") {
                this.visible = !this.visible;
                this.toggleVisibility();
            }
        });

        window.addEventListener("keyup", (event) => {
            if (event.key === "~" || event.key === "`") {
                this.visible = !this.visible;
                this.toggleVisibility();
            }
        });

        const registerLayers = () => {
            // Generate the Custom "X" icon image dynamically via canvas
            const iconId = "missed-connections-x-icon";
            if (!map.hasImage(iconId)) {
                const size = 64;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                
                ctx.lineCap = "round";

                // Draw thick white backing for high-contrast on any background
                ctx.strokeStyle = "#FFFFFF";
                ctx.lineWidth = 14;
                ctx.beginPath();
                ctx.moveTo(14, 14);
                ctx.lineTo(50, 50);
                ctx.stroke();
                
                ctx.beginPath();
                ctx.moveTo(50, 14);
                ctx.lineTo(14, 50);
                ctx.stroke();

                // Draw sharp red X foreground
                ctx.strokeStyle = "#FF6969";
                ctx.lineWidth = 8;
                ctx.beginPath();
                ctx.moveTo(14, 14);
                ctx.lineTo(50, 50);
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(50, 14);
                ctx.lineTo(14, 50);
                ctx.stroke();

                // Get raw image data to prevent "mismatched image size" Mapbox errors
                const imgData = ctx.getImageData(0, 0, size, size);

                // Pass the raw data structure directly to Mapbox with high-DPI scaling
                map.addImage(iconId, {
                    width: size,
                    height: size,
                    data: imgData.data
                }, { pixelRatio: 2 });
            }

            if (!map.getSource("missed-connections")) {
                api.map.registerSource("missed-connections", {
                    type: "geojson",
                    data: this.geojson
                });
            }

            // Register layer as a symbol/icon layer
            if (!map.getLayer("missed-connections-layer")) {
                api.map.registerLayer({
                    id: "missed-connections-layer",
                    type: "symbol",
                    source: "missed-connections",
                    layout: {
                        "icon-image": iconId,
                        "icon-allow-overlap": true,
                        "icon-ignore-placement": true,
                        "visibility" : "none",
                        // Native GPU-accelerated scaling based on map zoom levels
                        "icon-size": [
                            "interpolate",
                            ["linear"],
                            ["zoom"],
                            MIN_ZOOM, MIN_SCALE,
                            MAX_ZOOM, MAX_SCALE
                        ]
                    },
                    paint: {
                        "icon-opacity": OPACITY
                    }
                });
            }
        };

        // Initialize immediately
        registerLayers();

        // Ensure layers stick when map style or theme changes
        map.on("styledata", () => {
            registerLayers();
            this.updateMapData();
        });

        // Safe render pass check
        map.on("render", () => {
            if (!map.getLayer("missed-connections-layer")) {
                registerLayers();
            }
        });
    }, 
    
    /**
     * Toggles the layer's visibility on the map.
     */
    toggleVisibility() {
        const map = this.map;
        if (!map) return;

        try {
            if (map.getLayer("missed-connections-layer")) {
                const state = this.visible ? "visible" : "none";
                map.setLayoutProperty("missed-connections-layer", "visibility", state);
            }
        } catch (e) {
            console.error("Missed Connections: Failed to toggle visibility", e);
        }
    },

    /**
     * Queues checkTracks to run once at the end of the frame
     */
    queueCheckTracks() {
        if (this._tickTimeout) {
            clearTimeout(this._tickTimeout);
        }
        this._tickTimeout = setTimeout(() => {
            this.checkTracks();
            this._tickTimeout = null;
        }, 50);
    },

    /**
     * Identifies open endpoints and transforms them into GeoJSON features
     */
    checkTracks() {
        const api = window.SubwayBuilderAPI;
        const tracks = api.gameState.getTracks();

        if (!tracks || tracks.length === 0) {
            this.geojson.features = [];
            this.updateMapData();
            return;
        }

        // Helper to stringify coordinates for Map keys.
        // Rounding to 6 decimal places fixes floating-point precision issues.
        const getPointKey = (pt) => {
            const x = pt.x !== undefined ? pt.x : pt[0];
            const y = pt.y !== undefined ? pt.y : pt[1];
            return `${x.toFixed(6)},${y.toFixed(6)}`;
        };

        const endpointCounts = new Map();
        const trackEndpoints = [];

        // Pass 1: Gather endpoints and count their occurrences
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const start = track.coords[0];
            const end = track.coords[track.coords.length - 1];

            if (!start || !end) continue;

            const startKey = getPointKey(start);
            const endKey = getPointKey(end);

            endpointCounts.set(startKey, (endpointCounts.get(startKey) || 0) + 1);
            endpointCounts.set(endKey, (endpointCounts.get(endKey) || 0) + 1);

            // Store references to check in the second pass
            trackEndpoints.push({ start, startKey, end, endKey });
        }

        const unconnectedEndpoints = [];

        // Pass 2: Identify endpoints that only appear exactly once
        for (let i = 0; i < trackEndpoints.length; i++) {
            const { start, startKey, end, endKey } = trackEndpoints[i];

            if (endpointCounts.get(startKey) === 1) {
                unconnectedEndpoints.push(start);
            }
            if (endpointCounts.get(endKey) === 1) {
                unconnectedEndpoints.push(end);
            }
        }

        this.handleVisualAlerts(unconnectedEndpoints);
    },

    /**
     * Converts coordinates into GeoJSON Points and pushes updates to the map
     */
    handleVisualAlerts(unconnectedEndpoints) {
        // Output logs back to the developer console
        if (unconnectedEndpoints.length > 0) {
            console.warn(`Missed Connections: Found ${unconnectedEndpoints.length} dangling track end(s)!`, unconnectedEndpoints);
        } else {
            console.log("Missed Connections: All track alignments are clean.");
        }

        // Map coordinate pairs into GeoJSON Feature structures
        this.geojson.features = unconnectedEndpoints.map(point => {
            const [lon, lat] = this.getLonLat(point);
            return {
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [lon, lat]
                },
                properties: {}
            };
        });

        this.updateMapData();
    },

    /**
     * Safely triggers a data refresh on the map source
     */
    updateMapData() {
        const map = this.map;
        if (map && map.getSource("missed-connections")) {
            map.getSource("missed-connections").setData(this.geojson);
        }
    },

    /**
     * Normalizes different coordinate formats to [longitude, latitude].
     */
    getLonLat(p) {
        if (!p) return [NaN, NaN];
        if (Array.isArray(p)) return [p[0], p[1]];

        let lon = p.lng !== undefined ? p.lng : (p.lon !== undefined ? p.lon : (p.longitude !== undefined ? p.longitude : p.x));
        let lat = p.lat !== undefined ? p.lat : (p.latitude !== undefined ? p.latitude : p.y);

        return [lon, lat];
    },

    haversineDistance(p1, p2) {
        const [lon1, lat1] = this.getLonLat(p1);
        const [lon2, lat2] = this.getLonLat(p2);

        if (isNaN(lon1) || isNaN(lat1) || isNaN(lon2) || isNaN(lat2)) {
            return Infinity;
        }

        const R = 6371000;
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLon = (lon2 - lon1) * toRad;

        const a = 
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * 
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },

    arePointsConnected(p1, p2) {
        return p1.every((val, index) => val === p2[index]);
    }
};

missedConnections.init();
