import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import GUI from 'lil-gui';
import jsyaml from 'js-yaml';

const MAX_OLATS = 8;

const state = {
    dataRoot: './static/demo/',
    manifestPath: './static/demo/scene_manifest.yaml',
    sceneName: '',
    exposure: 0.0, // EV
    toneMapping: 'Reinhard',
    backgroundScale: 0.5,
    ambientBgEnabled: true,
    olats: [],
    batch: {
        colorEnabled: false,
        exposureEnabled: false,
        colorMode: 'Temp (K)',
        temperature: 6500.0,
        color: '#ffffff',
        ev: 0.0
    }
};

let renderer, scene, camera, mesh;
let gui;
let manifest = null;

const loadingEl = document.getElementById('demo-loading');
const TM_MODES = ['Linear', 'Reinhard', 'Filmic'];

// Helper functions for Color Temperature
function blackbodyToRGB(temperature) {
    // Ported from python blackbody_temperature_to_rgb
    temperature = Math.max(1000.0, Math.min(40000.0, temperature));
    const temp_d100 = temperature / 100.0;

    let red, green, blue;

    if (temp_d100 <= 66.0) {
        red = 255.0;
    } else {
        red = 329.698727446 * Math.pow(temp_d100 - 60.0, -0.1332047592);
    }

    if (temp_d100 <= 66.0) {
        green = 99.4708025861 * Math.log(temp_d100) - 161.1195681661;
    } else {
        green = 288.1221695283 * Math.pow(temp_d100 - 60.0, -0.0755148492);
    }

    if (temp_d100 >= 66.0) {
        blue = 255.0;
    } else if (temp_d100 <= 19.0) {
        blue = 0.0;
    } else {
        blue = 138.5177312231 * Math.log(temp_d100 - 10.0) - 305.0447927307;
    }

    const r = Math.max(0, Math.min(255, red)) / 255.0;
    const g = Math.max(0, Math.min(255, green)) / 255.0;
    const b = Math.max(0, Math.min(255, blue)) / 255.0;

    // Normalize by max component
    const maxComp = Math.max(r, g, b);
    if (maxComp > 0) {
        return new THREE.Vector3(r / maxComp, g / maxComp, b / maxComp);
    }
    return new THREE.Vector3(0, 0, 0);
}

function calculateCentroid(img) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    if (canvas.width === 0 || canvas.height === 0) return { x: 0.5, y: 0.5 };

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let sumX = 0;
    let sumY = 0;
    let count = 0;

    for (let i = 0; i < data.length; i += 4) {
        // Red channel threshold (masks are typically white on black)
        if (data[i] > 20) {
            const pixelIdx = i / 4;
            const x = pixelIdx % canvas.width;
            const y = Math.floor(pixelIdx / canvas.width);

            sumX += x;
            sumY += y;
            count++;
        }
    }

    if (count === 0) return { x: 0.5, y: 0.5 };

    return {
        x: (sumX / count) / canvas.width,
        y: (sumY / count) / canvas.height
    };
}

async function init() {
    const container = document.getElementById('demo-canvas-container');
    const guiContainer = document.getElementById('demo-gui-container');

    if (!container || !guiContainer) {
        console.error('Demo containers not found');
        return;
    }

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    // Initial size, will be updated by resize observer or event
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0); // Transparent background if needed, or match CSS
    container.appendChild(renderer.domElement);

    // Scene setup
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    camera.position.z = 1;

    // Create a quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    const material = createShaderMaterial(0);
    mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);

    // GUI
    gui = new GUI({ autoPlace: false, container: guiContainer, width: '100%' });
    // guiContainer.appendChild(gui.domElement); // lil-gui container option handles this

    // Initial load
    await loadManifest();

    window.addEventListener('resize', onWindowResize);
    const resizeObserver = new ResizeObserver(() => onWindowResize());
    resizeObserver.observe(container);

    animate();
}

function onWindowResize() {
    const container = document.getElementById('demo-canvas-container');
    if (container && renderer) {
        renderer.setSize(container.clientWidth, container.clientHeight);
    }
}

function createShaderMaterial(olatCount) {
    let unrolledLoop = '';
    for (let i = 0; i < MAX_OLATS; i++) {
        unrolledLoop += `
        if (${i} < olatCount) {
            vec4 os = texture2D(olatTextures[${i}], vUv);
            finalColor += os.rgb * olatIntensities[${i}] * olatColors[${i}];
        }
        `;
    }

    const vertexShader = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `;

    let fragmentShader = `
        precision highp float;

        uniform sampler2D backgroundTexture;
        uniform float backgroundScale;

        uniform int olatCount;
        uniform sampler2D olatTextures[${Math.max(1, MAX_OLATS)}];
        uniform vec3 olatColors[${Math.max(1, MAX_OLATS)}];
        uniform float olatIntensities[${Math.max(1, MAX_OLATS)}];

        uniform int toneMappingMode;
        uniform float maxPoint;

        varying vec2 vUv;

        vec3 reinhard_tonemap(vec3 x, float max_p) {
            return x * (1.0 + x / (max_p * max_p)) / (1.0 + x);
        }

        vec3 inv_reinhard(vec3 x, float max_p) {
            float M = max_p * max_p;
            vec3 term1 = sqrt(M * M * (x - 1.0) * (x - 1.0) + 4.0 * M * x);
            vec3 term2 = M * (x - 1.0);
            return (term1 + term2) / 2.0;
        }

        vec3 filmic_tonemap(vec3 x) {
            vec3 a = vec3(2.51);
            vec3 b = vec3(0.03);
            vec3 c = vec3(2.43);
            vec3 d = vec3(0.59);
            vec3 e = vec3(0.14);
            return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        vec3 inv_filmic(vec3 y) {
            vec3 a = vec3(2.51);
            vec3 b = vec3(0.03);
            vec3 c = vec3(2.43);
            vec3 d = vec3(0.59);
            vec3 e = vec3(0.14);

            vec3 A = y * c - a;
            vec3 B = y * d - b;
            vec3 C = y * e;

            vec3 D = B * B - 4.0 * A * C;
            vec3 sqrtD = sqrt(max(vec3(0.0), D));

            return (-B - sqrtD) / (2.0 * A);
        }

        vec3 srgb_to_linear(vec3 c) {
            return mix(
                c / 12.92,
                pow((c + 0.055) / 1.055, vec3(2.4)),
                step(0.04045, c)
            );
        }

        vec3 linear_to_srgb(vec3 c) {
            return mix(
                c * 12.92,
                1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
                step(0.0031308, c)
            );
        }

        void main() {
            vec4 bgSample = texture2D(backgroundTexture, vUv);
            vec3 bgLinear = srgb_to_linear(bgSample.rgb);

            if (toneMappingMode == 1) {
                bgLinear = inv_reinhard(bgLinear, maxPoint);
            } else if (toneMappingMode == 2) {
                bgLinear = inv_filmic(bgLinear);
            }

            vec3 finalColor = bgLinear * backgroundScale;

            ${unrolledLoop}

            if (toneMappingMode == 1) {
                finalColor = reinhard_tonemap(finalColor, maxPoint);
            } else if (toneMappingMode == 2) {
                finalColor = filmic_tonemap(finalColor);
            }

            gl_FragColor = vec4(linear_to_srgb(finalColor), 1.0);
        }
    `;

    const uniforms = {
        backgroundTexture: { value: null },
        backgroundScale: { value: 1.0 },
        olatCount: { value: olatCount },
        olatTextures: { value: new Array(MAX_OLATS).fill(null) },
        olatColors: { value: new Array(MAX_OLATS).fill(null).map(() => new THREE.Vector3(1, 1, 1)) },
        olatIntensities: { value: new Array(MAX_OLATS).fill(0.0) },
        toneMappingMode: { value: 1 },
        maxPoint: { value: 16.0 }
    };

    return new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: vertexShader,
        fragmentShader: fragmentShader,
        depthWrite: false,
        depthTest: false
    });
}

async function loadManifest() {
    try {
        const response = await fetch(state.manifestPath);
        if (!response.ok) throw new Error(`Failed to load manifest: ${response.statusText}`);
        const text = await response.text();
        manifest = jsyaml.load(text);

        const scenes = manifest.scenes ? Object.keys(manifest.scenes).sort() : [];
        if (scenes.length > 0) {
            state.sceneName = scenes[0];
        }

        updateSceneBar(scenes); // Update the visual scene bar
        updateSceneGUI(scenes);
        if (state.sceneName) {
            await loadScene(state.sceneName);
        }
    } catch (e) {
        console.error(e);
        // alert('Error loading manifest: ' + e.message);
        if (loadingEl) loadingEl.textContent = 'Error: ' + e.message;
    }
}

function updateSceneBar(scenes) {
    const bar = document.getElementById('demo-scene-bar');
    if (!bar) return;

    bar.innerHTML = ''; // Clear existing

    scenes.forEach(sceneName => {
        const sceneData = manifest.scenes[sceneName];
        if (!sceneData) return;

        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'demo-scene-thumbnail';
        thumbDiv.title = sceneName;
        if (sceneName === state.sceneName) {
            thumbDiv.classList.add('selected');
        }

        const img = document.createElement('img');
        // Use resolvePath logic for consistency, though inputs are typically images
        const inputPath = resolvePath(sceneData.input);
        img.src = inputPath;
        img.alt = sceneName;
        img.loading = 'lazy'; // Native lazy loading for thumbnails
        img.decoding = 'async'; // Non-blocking decode

        const label = document.createElement('div');
        label.className = 'demo-scene-label';
        label.textContent = sceneName;

        thumbDiv.appendChild(img);
        thumbDiv.appendChild(label);

        thumbDiv.addEventListener('click', () => {
            // Update selection state UI
            document.querySelectorAll('.demo-scene-thumbnail').forEach(el => el.classList.remove('selected'));
            thumbDiv.classList.add('selected');

            // Trigger scene load via state change logic
            // Since we bound GUI to state.sceneName, updating state and calling loadScene works,
            // but we need to keep GUI in sync. Ideally we just update the GUI controller.

            // Find the scene controller
            const configFolder = gui.folders.find(f => f._title === 'Global Settings');
            if (configFolder) {
                const sceneCtrl = configFolder.controllers.find(c => c._name === 'Scene');
                if (sceneCtrl) {
                    sceneCtrl.setValue(sceneName); // This triggers onChange(loadScene)
                }
            }
        });

        bar.appendChild(thumbDiv);
    });
}

function resolvePath(pathStr) {
    if (!pathStr) return null;
    const s = String(pathStr);
    if (s.startsWith('/')) {
        const projectRoot = './';
        if (s.startsWith(projectRoot)) {
            return state.dataRoot + s.substring(projectRoot.length).replace(/^\//, '');
        }
        return s;
    }
    return state.dataRoot + s;
}

async function loadScene(sceneName) {
    if (loadingEl) loadingEl.style.opacity = 1;

    // Update visual selection in case loadScene was called from GUI dropdown
    const thumbs = document.querySelectorAll('.demo-scene-thumbnail');
    thumbs.forEach(t => {
        if (t.title === sceneName) t.classList.add('selected');
        else t.classList.remove('selected');
    });

    const sceneData = manifest.scenes[sceneName];
    if (!sceneData) return;

    const ours = sceneData.ours;
    if (!ours) return;

    const assets = {
        bgPath: resolvePath(ours.bg),
        olatPaths: (ours.olat || []).map(p => resolvePath(p)),
        maskPaths: (ours.mask || []).map(p => resolvePath(p)),
        inputPath: resolvePath(sceneData.input)
    };

    console.log('Loading assets:', assets);

    // Set Input Image
    const inputImg = document.getElementById('demo-input-image');
    if (inputImg && assets.inputPath) {
        inputImg.src = assets.inputPath;
    }

    // Prepare Mask Container
    const maskContainer = document.getElementById('demo-mask-container');
    if (maskContainer) {
        maskContainer.innerHTML = '';
    }

    const textureLoader = new THREE.TextureLoader();
    const exrLoader = new EXRLoader();
    exrLoader.setDataType(THREE.FloatType);

    const loadTex = async (p) => p ? textureLoader.loadAsync(p) : null;
    const loadImg = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = (e) => { console.warn('Failed to load image', src, e); resolve(null); };
        img.src = src;
    });

    try {
        const bgTexture = await loadTex(assets.bgPath);

        state.textures = {
            background: bgTexture
        };

        if (assets.olatPaths.length > MAX_OLATS) {
            console.warn(`Scene has ${assets.olatPaths.length} OLATs, but max is ${MAX_OLATS}. Truncating.`);
        }

        const pathsToLoad = assets.olatPaths.slice(0, MAX_OLATS);
        const olatPromises = pathsToLoad.map(p => exrLoader.loadAsync(p));

        const maskPathsToLoad = assets.maskPaths.slice(0, MAX_OLATS);
        const maskPromises = maskPathsToLoad.map(p => loadImg(p));

        const [olatTextures, maskImages] = await Promise.all([
            Promise.all(olatPromises),
            Promise.all(maskPromises)
        ]);

        // Adjust aspect ratio if we have mask images
        if (maskImages.length > 0 && maskImages[0]) {
             const aspect = maskImages[0].naturalWidth / maskImages[0].naturalHeight;
             const containers = document.querySelectorAll('.demo-image-container');
             containers.forEach(c => c.style.aspectRatio = `${aspect}`);
        }

        state.olats = pathsToLoad.map((p, idx) => {
            const maskImg = (idx < maskImages.length) ? maskImages[idx] : null;
            return {
                label: p.split('/').pop().replace('.exr', ''),
                intensity: 1.0,
                color: '#ffffff',
                rgb: new THREE.Vector3(1, 1, 1),
                texture: olatTextures[idx],
                enabled: true,
                ev: 0.0,
                colorMode: 'Temp (K)', // Default mode
                temperature: 6500.0,
                maskImage: maskImg,
                centroid: maskImg ? calculateCentroid(maskImg) : {x:0.5, y:0.5}
            };
        });

        const material = mesh.material;
        material.uniforms.backgroundTexture.value = bgTexture;
        material.uniforms.olatCount.value = state.olats.length;

        for (let i = 0; i < MAX_OLATS; i++) {
            if (i < state.olats.length) {
                material.uniforms.olatTextures.value[i] = state.olats[i].texture;
            } else {
                if (olatTextures.length > 0) {
                     material.uniforms.olatTextures.value[i] = olatTextures[0];
                } else if (bgTexture) {
                     material.uniforms.olatTextures.value[i] = bgTexture;
                }
            }
        }

        material.needsUpdate = true;

        // Render Masks and Buttons
        if (maskContainer) {
            state.olats.forEach((olat, idx) => {
                if (olat.maskImage) {
                    const displayImg = document.createElement('img');
                    displayImg.src = olat.maskImage.src;
                    displayImg.className = 'mask-layer';
                    maskContainer.appendChild(displayImg);

                    const btn = document.createElement('div');
                    btn.className = 'mask-overlay-btn';
                    // btn.style.left = `${olat.centroid.x * 100}%`;
                    // btn.style.top = `${olat.centroid.y * 100}%`;
                    // Centroids are top-left based, CSS left/top is top-left based.
                    // But check if y axis is flipped. Canvas 0,0 is top-left. HTML is top-left. Correct.
                    btn.style.left = `${olat.centroid.x * 100}%`;
                    btn.style.top = `${olat.centroid.y * 100}%`;
                    btn.textContent = `m${String(idx).padStart(2, '0')}`;

                    btn.onclick = (e) => {
                        e.stopPropagation(); // prevent other clicks
                        olat.enabled = !olat.enabled;
                        updateShaderUniforms();
                        // Also update GUI controller if possible
                        // The 'listen()' in GUI handles external updates to the bound object property.
                    };

                    olat.maskBtn = btn;
                    maskContainer.appendChild(btn);
                }
            });

            // Add ambient bg button at bottom right
            const bgBtn = document.createElement('div');
            bgBtn.className = 'mask-overlay-btn';
            bgBtn.style.left = '95%';
            bgBtn.style.top = '95%';
            bgBtn.style.background = 'rgba(255, 140, 0, 0.8)'; // Orange color to differentiate
            bgBtn.textContent = 'bg';
            bgBtn.onclick = (e) => {
                e.stopPropagation();
                state.ambientBgEnabled = !state.ambientBgEnabled;
                updateShaderUniforms();
                // Update GUI checkbox if it exists
                const olatFolder = gui.children.find(c => c._title === 'OLATs');
                if (olatFolder) {
                    const ambientCtrl = olatFolder.controllers.find(c => c._name === 'Ambient Enabled');
                    if (ambientCtrl) {
                        ambientCtrl.setValue(state.ambientBgEnabled);
                    }
                }
            };
            // Set initial state
            state.ambientBgBtn = bgBtn;
            maskContainer.appendChild(bgBtn);
        }

        updateOLATGUI();
        updateShaderUniforms();

    } catch (e) {
        console.error(e);
        // alert('Error loading scene assets: ' + e.message);
    } finally {
        if (loadingEl) loadingEl.style.opacity = 0;
    }
}

function updateSceneGUI(scenes) {
    if (gui) {
        gui.destroy();
    }

    const guiContainer = document.getElementById('demo-gui-container');
    gui = new GUI({ autoPlace: false, container: guiContainer, width: '100%' });
    // guiContainer.appendChild(gui.domElement);

    const configFolder = gui.addFolder('Global Settings');
    // configFolder.add(state, 'dataRoot').name('Data Root').onFinishChange(() => loadManifest());

    if (scenes.length > 0) {
        configFolder.add(state, 'sceneName', scenes).name('Scene').onChange(loadScene);
    }

    configFolder.add(state, 'toneMapping', TM_MODES).name('Tone Mapping').onChange(updateShaderUniforms);

    const obj = {
        reset: () => {
            state.olats.forEach(o => {
                o.intensity = 1.0;
                o.ev = 0.0;
                o.color = '#ffffff';
                o.rgb.set(1,1,1);
                o.enabled = true;
                o.colorMode = 'Temp (K)';
                o.temperature = 6500.0;
            });
            updateOLATGUI();
            updateShaderUniforms();
        },
        download: () => {
            renderer.render(scene, camera);
            const link = document.createElement('a');
            link.download = `${state.sceneName || 'scene'}_blend.png`;
            link.href = renderer.domElement.toDataURL('image/png');
            link.click();
        }
    };
    configFolder.add(obj, 'reset').name('Reset OLATs');
    configFolder.add(obj, 'download').name('Download Result');
}

function updateOLATGUI() {
    let folder = gui.children.find(c => c._title === 'OLATs');
    if (folder) folder.destroy();

    folder = gui.addFolder('OLATs');

    folder.add(state, 'ambientBgEnabled').name('Ambient Enabled').onChange((v) => {
        updateShaderUniforms();
        // Update mask button style
        if (state.ambientBgBtn) {
            if (v) {
                state.ambientBgBtn.classList.remove('inactive');
                state.ambientBgBtn.style.background = 'rgba(255, 140, 0, 0.8)';
            } else {
                state.ambientBgBtn.classList.add('inactive');
            }
        }
    }).listen();

    folder.add(state, 'backgroundScale', 0, 3).name('Ambient light').onChange(updateShaderUniforms);

    state.olats.forEach((olat, idx) => {
        const sub = folder.addFolder(olat.label || `OLAT ${idx}`);

        sub.add(olat, 'enabled').name('Enabled').onChange(updateShaderUniforms).listen();

        const updateColor = () => {
            if (olat.colorMode === 'Temp (K)') {
                olat.rgb.copy(blackbodyToRGB(olat.temperature));
            } else {
                const c = new THREE.Color(olat.color);
                olat.rgb.set(c.r, c.g, c.b);
            }
            updateShaderUniforms();
        };

        sub.add(olat, 'colorMode', ['Temp (K)', 'RGB picker']).name('Color Mode').onChange((v) => {
             tempCtrl.show(v === 'Temp (K)');
             colorCtrl.show(v === 'RGB picker');
             updateColor();
        }).listen();

        const tempCtrl = sub.add(olat, 'temperature', 2000, 12000).name('Temp (K)').onChange(updateColor).listen();

        const colorCtrl = sub.addColor(olat, 'color').name('Color').onChange((v) => {
            if (olat.colorMode === 'RGB picker') {
                 updateColor();
            }
        }).listen();

        tempCtrl.show(olat.colorMode === 'Temp (K)');
        colorCtrl.show(olat.colorMode === 'RGB picker');

        sub.add(olat, 'ev', -5.0, 2.0).name('Exposure (EV)').onChange((v) => {
            olat.intensity = Math.pow(2, v);
            updateShaderUniforms();
        }).listen();
    });

    // Check if All OLAT Control folder exists at root level
    let batchFolder = gui.children.find(c => c._title === 'All OLAT Control');
    if (batchFolder) batchFolder.destroy();

    batchFolder = gui.addFolder('All OLAT Control');

    const updateBatchColor = () => {
        if (!state.batch.colorEnabled) return;
        const isTemp = state.batch.colorMode === 'Temp (K)';

        state.olats.forEach(olat => {
             olat.colorMode = state.batch.colorMode;
             if (isTemp) {
                 olat.temperature = state.batch.temperature;
                 olat.rgb.copy(blackbodyToRGB(olat.temperature));
             } else {
                 olat.color = state.batch.color;
                 const c = new THREE.Color(olat.color);
                 olat.rgb.set(c.r, c.g, c.b);
             }
        });
        updateShaderUniforms();
    };

    batchFolder.add(state.batch, 'colorEnabled').name('Enable Color Ctrl').onChange(updateBatchColor);

    batchFolder.add(state.batch, 'colorMode', ['Temp (K)', 'RGB picker']).name('Color Mode').onChange((v) => {
        bTemp.show(v === 'Temp (K)');
        bColor.show(v === 'RGB picker');
        updateBatchColor();
    });

    const bTemp = batchFolder.add(state.batch, 'temperature', 2000, 12000).name('Temp (K)').onChange(updateBatchColor);
    const bColor = batchFolder.addColor(state.batch, 'color').name('Color').onChange(updateBatchColor);

    bTemp.show(state.batch.colorMode === 'Temp (K)');
    bColor.show(state.batch.colorMode === 'RGB picker');

    const updateBatchExposure = () => {
        if (!state.batch.exposureEnabled) return;
        state.olats.forEach(olat => {
            olat.ev = state.batch.ev;
            olat.intensity = Math.pow(2, state.batch.ev);
        });
        updateShaderUniforms();
    };

    batchFolder.add(state.batch, 'exposureEnabled').name('Enable Exp Ctrl').onChange(updateBatchExposure);
    batchFolder.add(state.batch, 'ev', -5.0, 2.0).name('Exposure (EV)').onChange(updateBatchExposure);
}

function updateShaderUniforms() {
    if (!mesh || !mesh.material) return;

    const m = mesh.material;

    m.uniforms.backgroundTexture.value = state.textures ? state.textures.background : null;
    m.uniforms.backgroundScale.value = state.ambientBgEnabled ? state.backgroundScale : 0.0;

    const modeIdx = TM_MODES.indexOf(state.toneMapping);
    m.uniforms.toneMappingMode.value = modeIdx;

    // Update bg button style
    if (state.ambientBgBtn) {
        if (state.ambientBgEnabled) {
            state.ambientBgBtn.classList.remove('inactive');
            state.ambientBgBtn.style.background = 'rgba(255, 140, 0, 0.8)';
        } else {
            state.ambientBgBtn.classList.add('inactive');
        }
    }

    for (let i = 0; i < MAX_OLATS; i++) {
        if (i < state.olats.length) {
            const o = state.olats[i];
            const intensity = o.enabled ? o.intensity : 0.0;
            m.uniforms.olatIntensities.value[i] = intensity;
            m.uniforms.olatColors.value[i].copy(o.rgb);

            // Update mask button style
            if (o.maskBtn) {
                if (o.enabled) o.maskBtn.classList.remove('inactive');
                else o.maskBtn.classList.add('inactive');
            }
        } else {
            m.uniforms.olatIntensities.value[i] = 0.0;
        }
    }
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

document.addEventListener('DOMContentLoaded', () => {
    // We wait for DOM, although init is called at end of module which is effectively deferred.
    // But explicit is better if we are loading this module async in a page.
    // init() is called at the end of the script, so if it's type="module", it runs after parse.
});

init();
