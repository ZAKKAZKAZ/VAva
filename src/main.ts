import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import { io, Socket } from 'socket.io-client';

// MediaPipe & Kalidokit (Loaded via CDN in index.html)
declare const FaceMesh: any;
declare const Camera: any;
declare const Kalidokit: any;

// --- Global Variables ---
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
interface LoadedAvatar {
  id: string;
  name: string;
  type: 'vrm' | 'fbx';
  vrm?: VRM;
  fbx?: THREE.Group;
  initialX: number;
}
const loadedAvatars: LoadedAvatar[] = [];
let activeAvatarIndex = 0;

let currentVrm: VRM | undefined;
let currentFbx: THREE.Group | undefined;
let currentWorld: THREE.Group | undefined;
let defaultWorldGroup: THREE.Group;
let mainLight: THREE.DirectionalLight;
let sunSphere: THREE.Mesh;
let skyboxTexture: THREE.Texture | undefined;
let sunTimeAngle = 45; // Sun position angle (0 to 360 degrees)
let sunSpeedFactor = 1.0; // Time progression speed multiplier
let isCustomSunColor = false;
const customSunColor = new THREE.Color('#ffffff');
let fbxMixer: THREE.AnimationMixer | undefined;
const clock = new THREE.Clock();

// Tracking Targets
const lookAtTarget = new THREE.Object3D();
let isCameraTracking = false;

// Physics / Movement
const keys = { w: false, a: false, s: false, d: false };
let jumpVelocity = 0;
let isJumping = false;

// Procedural Animation State
let walkTime = 0;
let currentAnimState = 'idle'; // idle, walk, walkBack, strafeLeft, strafeRight, jump
let currentCameraMode: 'TPS' | 'FPS' = 'TPS';

// --- Multiplayer Network ---
interface RemotePlayerState {
  name: string;
  position: { x: number; y: number; z: number };
  rotationY: number;
  boneRots: Record<string, { x: number; y: number; z: number }>;
  avatarData?: {
    fileName: string;
    type: 'vrm' | 'fbx';
    buffer: ArrayBuffer;
  };
}
interface RemotePlayerObj {
  group: THREE.Group;
  head: THREE.Object3D;
  targetPos: THREE.Vector3;
  targetRotY: number;
  nameSprite: THREE.Sprite;
  vrm?: VRM;
  fbx?: THREE.Group;
  defaultVisuals?: THREE.Group;
  mixer?: THREE.AnimationMixer;
  avatarKey?: string;
  isAvatarLoading?: boolean;
}
let socket: Socket | null = null;
const remotePlayers = new Map<string, RemotePlayerObj>();
let localPlayerName = localStorage.getItem('localPlayerName') || ('Player_' + Math.floor(Math.random() * 9000 + 1000));
let localRoomName = localStorage.getItem('localRoomName') || 'CHAT';
let localPlayerId = localStorage.getItem('localPlayerId');
if (!localPlayerId) {
  localPlayerId = Math.random().toString(36).substring(2, 15);
  localStorage.setItem('localPlayerId', localPlayerId);
}
let localAvatarCache: { fileName: string; type: 'vrm' | 'fbx'; buffer: ArrayBuffer } | null = null;

// IndexedDB Avatar Cache
const avatarDB = {
  db: null as IDBDatabase | null,
  init() {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('AvatarCacheDB', 1);
      req.onupgradeneeded = (e: any) => {
        e.target.result.createObjectStore('avatars');
      };
      req.onsuccess = (e: any) => {
        this.db = e.target.result;
        resolve();
      };
      req.onerror = () => reject();
    });
  },
  async set(key: string, data: ArrayBuffer) {
    if (!this.db) await this.init();
    return new Promise<void>((resolve) => {
      const tx = this.db!.transaction('avatars', 'readwrite');
      tx.objectStore('avatars').put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
  async get(key: string): Promise<ArrayBuffer | null> {
    if (!this.db) await this.init();
    return new Promise((resolve) => {
      const tx = this.db!.transaction('avatars', 'readonly');
      const req = tx.objectStore('avatars').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }
};

// WebRTC & Chat Globals
interface PeerConnectionInfo {
  pc: RTCPeerConnection;
  audio?: HTMLAudioElement;
}
const peerConnections = new Map<string, PeerConnectionInfo>();
let localStream: MediaStream | null = null;
let isMicActive = false;

let lastNetworkSend = 0;
const SEND_INTERVAL = 1000 / 20; // 20fps
const PLAYER_COLORS = [
  0x6c8eff, 0xff6c8e, 0x6cffb4, 0xffca6c,
  0xcc6cff, 0xff8c6c, 0x6ce4ff, 0xb4ff6c,
];

// UI Elements
const statusDisplay = document.getElementById('status-display') as HTMLParagraphElement;
const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
const autoRotateCheckbox = document.getElementById('auto-rotate') as HTMLInputElement;
const lookAtMouseCheckbox = document.getElementById('look-at-mouse') as HTMLInputElement;
const webcamBtn = document.getElementById('webcam-btn') as HTMLButtonElement;
const videoElement = document.getElementById('video') as HTMLVideoElement;

// Face Tracking
let faceMesh: any;
let cameraManager: any;

init();
animate();

function init() {
  const container = document.getElementById('canvas-container');
  if (!container) return;

  // Scene setup
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a1c23');
  scene.fog = new THREE.Fog('#1a1c23', 10, 50);

  // Camera setup
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.3, 3);
  lookAtTarget.position.set(0, 1.3, 3);
  scene.add(lookAtTarget);

  // Renderer setup
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // Controls setup
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
  controls.update();

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  mainLight = new THREE.DirectionalLight(0xffffff, 2.0);
  mainLight.position.set(2, 5, 3);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.width = 1024;
  mainLight.shadow.mapSize.height = 1024;
  // Reduce shadow bias to prevent shadow acne as the sun moves
  mainLight.shadow.bias = -0.0005;
  scene.add(mainLight);

  // Visual Sun Sphere in the sky
  const sunGeo = new THREE.SphereGeometry(1.2, 16, 16);
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xffdd66 });
  sunSphere = new THREE.Mesh(sunGeo, sunMat);
  scene.add(sunSphere);

  const fillLight = new THREE.DirectionalLight(0xa0a5b1, 0.8);
  fillLight.position.set(-2, 2, -2);
  scene.add(fillLight);

  // Build Default Virtual Stage (World)
  buildDefaultWorld();

  // Event Listeners
  window.addEventListener('resize', onWindowResize);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('click', onClick);
  
  // Clean disconnect on page reload/close to prevent ghost avatars
  window.addEventListener('beforeunload', () => {
    if (socket && socket.connected) {
      socket.disconnect();
    }
  });
  
  // Keyboard Listeners
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const fileInput = document.getElementById('model-upload') as HTMLInputElement;
  fileInput.addEventListener('change', handleFileUpload);

  const worldFileInput = document.getElementById('world-upload') as HTMLInputElement;
  worldFileInput.addEventListener('change', handleWorldUpload);

  const skyboxFileInput = document.getElementById('skybox-upload') as HTMLInputElement;
  skyboxFileInput.addEventListener('change', handleSkyboxUpload);

  const bgmFileInput = document.getElementById('bgm-upload') as HTMLInputElement;
  if (bgmFileInput) bgmFileInput.addEventListener('change', handleBgmUpload);

  const bgmVolumeSlider = document.getElementById('bgm-volume') as HTMLInputElement;
  if (bgmVolumeSlider) {
    bgmVolumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat((e.target as HTMLInputElement).value);
      const bgmPlayer = document.getElementById('bgm-player') as HTMLAudioElement;
      if (bgmPlayer) bgmPlayer.volume = vol;
    });
  }
  
  webcamBtn.addEventListener('click', toggleWebcam);

  // Camera Mode UI
  const cameraModeBtn = document.getElementById('camera-mode-btn') as HTMLButtonElement;
  if (cameraModeBtn) {
    cameraModeBtn.addEventListener('click', () => {
      const activeModel = currentVrm ? currentVrm.scene : currentFbx ?? null;
      if (currentCameraMode === 'TPS') {
        currentCameraMode = 'FPS';
        cameraModeBtn.innerHTML = '<span>🎥 カメラ視点: FPS (1人称)</span>';
      } else {
        currentCameraMode = 'TPS';
        cameraModeBtn.innerHTML = '<span>🎥 カメラ視点: TPS (3人称)</span>';
        if (activeModel) {
          // Reset camera distance for TPS
          const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(activeModel.quaternion);
          camera.position.copy(activeModel.position).add(new THREE.Vector3(0, 1.5, 0)).add(forward.multiplyScalar(2.5));
        }
      }
    });
  }

  // Network UI
  const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
  const nameInput  = document.getElementById('player-name') as HTMLInputElement;
  const roomInput  = document.getElementById('room-name') as HTMLInputElement;
  nameInput.value  = localPlayerName;
  roomInput.value  = localRoomName;
  nameInput.addEventListener('change', () => { 
    localPlayerName = nameInput.value.trim() || localPlayerName; 
    localStorage.setItem('localPlayerName', localPlayerName);
  });
  roomInput.addEventListener('change', () => { 
    localRoomName = roomInput.value.trim() || 'CHAT'; 
    localStorage.setItem('localRoomName', localRoomName);
  });
  connectBtn.addEventListener('click', () => {
    if (socket && socket.connected) {
      disconnectNetwork();
      connectBtn.textContent = '🌐 サーバー接続';
      connectBtn.classList.remove('active');
    } else {
      localPlayerName = nameInput.value.trim() || localPlayerName;
      localRoomName   = roomInput.value.trim() || 'CHAT';
      initNetwork();
      connectBtn.textContent = '⛔ 切断';
      connectBtn.classList.add('active');
    }
  });

  // QR Code Popup Event
  const qrBtn = document.getElementById('qr-btn') as HTMLButtonElement;
  const qrModal = document.getElementById('qr-modal') as HTMLDivElement;
  const qrImage = document.getElementById('qr-image') as HTMLImageElement;
  const qrUrlText = document.getElementById('qr-url-text') as HTMLDivElement;
  const modalClose = document.getElementById('modal-close') as HTMLButtonElement;

  qrBtn.addEventListener('click', () => {
    // Determine target IP: use 192.168.10.19 if localhost, otherwise use current hostname
    const hostname = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? '192.168.10.19' 
      : window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    const connectUrl = `${window.location.protocol}//${hostname}${port}/`;
    
    // QR Code API
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(connectUrl)}`;
    
    qrImage.src = qrApiUrl;
    qrUrlText.textContent = connectUrl;
    qrModal.classList.add('active');
  });

  modalClose.addEventListener('click', () => {
    qrModal.classList.remove('active');
  });

  // Toggle Control Panel
  const panelToggle = document.getElementById('panel-toggle') as HTMLButtonElement;
  const controlsPanel = document.querySelector('.controls-panel') as HTMLDivElement;

  panelToggle.addEventListener('click', () => {
    const isCollapsed = controlsPanel.classList.toggle('collapsed');
    if (isCollapsed) {
      panelToggle.textContent = '⚙️ メニューを開く';
      panelToggle.style.bottom = '2rem';
      panelToggle.style.left = '2rem';
    } else {
      panelToggle.textContent = '⚙️ メニューを閉じる';
    }
  });

  // Global Error Catch to show in UI
  window.addEventListener('error', (event) => {
    statusDisplay.innerText = `⚠️ エラー: ${event.message}`;
    statusDisplay.style.color = '#ff6c8e';
  });

  // World adjustment UI wiring
  const worldPosX = document.getElementById('world-pos-x') as HTMLInputElement;
  const worldPosY = document.getElementById('world-pos-y') as HTMLInputElement;
  const worldPosZ = document.getElementById('world-pos-z') as HTMLInputElement;
  const worldRotY = document.getElementById('world-rot-y') as HTMLInputElement;
  const worldScale = document.getElementById('world-scale') as HTMLInputElement;

  const valWorldX = document.getElementById('val-world-x') as HTMLSpanElement;
  const valWorldY = document.getElementById('val-world-y') as HTMLSpanElement;
  const valWorldZ = document.getElementById('val-world-z') as HTMLSpanElement;
  const valWorldRotY = document.getElementById('val-world-roty') as HTMLSpanElement;
  const valWorldScale = document.getElementById('val-world-scale') as HTMLSpanElement;

  function updateWorldTransforms() {
    if (!currentWorld) return;
    const x = parseFloat(worldPosX.value);
    const y = parseFloat(worldPosY.value);
    const z = parseFloat(worldPosZ.value);
    const rY = THREE.MathUtils.degToRad(parseFloat(worldRotY.value));
    const s = parseFloat(worldScale.value);

    currentWorld.position.set(x, y, z);
    currentWorld.rotation.y = rY;
    currentWorld.scale.setScalar(s);

    valWorldX.textContent = x.toFixed(1);
    valWorldY.textContent = y.toFixed(1);
    valWorldZ.textContent = z.toFixed(1);
    valWorldRotY.textContent = worldRotY.value;
    valWorldScale.textContent = s.toFixed(2);

    if (socket && socket.connected) {
      socket.emit('world-transform', { x, y, z, rY, s });
    }
  }

  worldPosX.addEventListener('input', updateWorldTransforms);
  worldPosY.addEventListener('input', updateWorldTransforms);
  worldPosZ.addEventListener('input', updateWorldTransforms);
  worldRotY.addEventListener('input', updateWorldTransforms);
  worldScale.addEventListener('input', updateWorldTransforms);

  // Sun and Time UI wiring
  const sunTimeSlider = document.getElementById('sun-time') as HTMLInputElement;
  const sunSpeedSlider = document.getElementById('sun-speed') as HTMLInputElement;
  const sunColorPicker = document.getElementById('sun-color') as HTMLInputElement;
  const resetSunColorBtn = document.getElementById('reset-sun-color') as HTMLButtonElement;

  const valSunTime = document.getElementById('val-sun-time') as HTMLSpanElement;
  const valSunSpeed = document.getElementById('val-sun-speed') as HTMLSpanElement;

  // 太陽と時間の変更をサーバーに通知する共通関数
  function shareSunSettings() {
    if (socket && socket.connected) {
      socket.emit('sun-settings-share', {
        timeAngle: sunTimeAngle,
        speedFactor: sunSpeedFactor,
        isCustomColor: isCustomSunColor,
        colorHex: sunColorPicker.value
      });
    }
  }

  sunTimeSlider.addEventListener('input', () => {
    sunTimeAngle = parseFloat(sunTimeSlider.value);
    valSunTime.textContent = sunTimeSlider.value;
    shareSunSettings();
  });

  sunSpeedSlider.addEventListener('input', () => {
    sunSpeedFactor = parseFloat(sunSpeedSlider.value);
    valSunSpeed.textContent = sunSpeedFactor.toFixed(1);
    shareSunSettings();
  });

  sunColorPicker.addEventListener('input', () => {
    customSunColor.set(sunColorPicker.value);
    isCustomSunColor = true;
    shareSunSettings();
  });

  resetSunColorBtn.addEventListener('click', () => {
    isCustomSunColor = false;
    sunColorPicker.value = '#ffffff';
    shareSunSettings();
  });

  // Avatar selector UI wiring
  const avatarSelect = document.getElementById('avatar-select') as HTMLSelectElement;
  avatarSelect.addEventListener('change', () => {
    switchActiveAvatar(parseInt(avatarSelect.value));
  });

  // --- Mobile Virtual Joystick & Jump Button Setup ---
  const mobileControls = document.getElementById('mobile-controls') as HTMLDivElement;
  const joystickZone = document.getElementById('joystick-zone') as HTMLDivElement;
  const joystickKnob = document.getElementById('joystick-knob') as HTMLDivElement;
  const mobileJumpBtn = document.getElementById('mobile-jump-btn') as HTMLButtonElement;

  // Show mobile controls if a touch event is detected
  const showMobileControls = () => {
    if (mobileControls) {
      mobileControls.style.display = 'flex';
    }
  };
  window.addEventListener('touchstart', showMobileControls, { once: true });

  let joystickActive = false;
  let joystickTouchId: number | null = null;
  let startX = 0;
  let startY = 0;
  const maxDragDistance = 45; // Max radius to drag the joystick knob in pixels

  if (joystickZone && joystickKnob) {
    const handleJoystickStart = (clientX: number, clientY: number, touchId: number | null = null) => {
      joystickActive = true;
      joystickTouchId = touchId;
      const rect = joystickZone.getBoundingClientRect();
      startX = rect.left + rect.width / 2;
      startY = rect.top + rect.height / 2;
    };

    const handleJoystickMove = (clientX: number, clientY: number) => {
      if (!joystickActive) return;

      let deltaX = clientX - startX;
      let deltaY = clientY - startY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance > maxDragDistance) {
        deltaX = (deltaX / distance) * maxDragDistance;
        deltaY = (deltaY / distance) * maxDragDistance;
      }

      // Visually move the knob
      joystickKnob.style.transform = `translate(${deltaX}px, ${deltaY}px)`;

      // Map drag to normalized keys (-1.0 to 1.0)
      const normX = deltaX / maxDragDistance;
      const normY = deltaY / maxDragDistance;

      const threshold = 0.35;
      keys.w = normY < -threshold;
      keys.s = normY > threshold;
      keys.a = normX < -threshold;
      keys.d = normX > threshold;
    };

    const handleJoystickEnd = () => {
      joystickActive = false;
      joystickTouchId = null;
      joystickKnob.style.transform = 'translate(0px, 0px)';
      keys.w = false;
      keys.s = false;
      keys.a = false;
      keys.d = false;
    };

    // Touch listeners
    joystickZone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      handleJoystickStart(touch.clientX, touch.clientY, touch.identifier);
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      if (!joystickActive) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystickTouchId) {
          handleJoystickMove(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
          break;
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      if (!joystickActive) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystickTouchId) {
          handleJoystickEnd();
          break;
        }
      }
    });

    // Mouse listeners for local testing / hybrid devices
    joystickZone.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handleJoystickStart(e.clientX, e.clientY);
    });

    window.addEventListener('mousemove', (e) => {
      if (joystickActive) {
        handleJoystickMove(e.clientX, e.clientY);
      }
    });

    window.addEventListener('mouseup', handleJoystickEnd);
  }

  if (mobileJumpBtn) {
    const triggerJump = (e: Event) => {
      e.preventDefault();
      if (!isJumping) {
        jumpVelocity = 7.0;
        isJumping = true;
      }
    };
    mobileJumpBtn.addEventListener('touchstart', triggerJump, { passive: false });
    mobileJumpBtn.addEventListener('mousedown', triggerJump);
  }

  // --- Text Chat UI Wiring ---
  const chatInput = document.getElementById('chat-input') as HTMLInputElement;
  const chatSendBtn = document.getElementById('chat-send-btn') as HTMLButtonElement;

  function sendChatMessage() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text) return;

    if (socket && socket.connected) {
      socket.emit('chat-msg', text);
      appendChatMessage('自分', text);
    } else {
      appendChatMessage('システム', '⚠️ サーバーに接続されていません。', true);
    }
    chatInput.value = '';
  }

  if (chatSendBtn && chatInput) {
    chatSendBtn.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage();
      }
    });
  }

  // --- Voice Chat UI Wiring ---
  const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
  if (micBtn) {
    micBtn.addEventListener('click', toggleMic);
  }

  // --- Restore Cached Local Avatar and World ---
  const savedAvatarName = localStorage.getItem('my_avatar_filename');
  const savedAvatarType = localStorage.getItem('my_avatar_type');
  if (savedAvatarName && savedAvatarType) {
    avatarDB.get('my_avatar').then(buffer => {
      if (buffer) {
        console.log('[LocalCache] Restored saved avatar:', savedAvatarName);
        localAvatarCache = {
          fileName: savedAvatarName,
          type: savedAvatarType as 'vrm'|'fbx',
          buffer: buffer
        };
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        statusDisplay.innerText = `${savedAvatarName} を読み込み中...`;
        loadingOverlay.classList.remove('hidden');
        if (savedAvatarType === 'vrm') loadVRM(blobUrl, savedAvatarName);
        else loadFBX(blobUrl, savedAvatarName);
      }
    });
  }

  const savedWorldName = localStorage.getItem('my_world_filename');
  const savedWorldType = localStorage.getItem('my_world_type');
  if (savedWorldName && savedWorldType) {
    avatarDB.get('my_world').then(buffer => {
      if (buffer) {
        console.log('[LocalCache] Restored saved world:', savedWorldName);
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        statusDisplay.innerText = `${savedWorldName} を読み込み中...`;
        loadingOverlay.classList.remove('hidden');
        if (savedWorldType === 'glb' || savedWorldType === 'gltf') loadWorldGLTF(blobUrl);
        else loadWorldFBX(blobUrl);
      }
    });
  }

  // Restore Cached BGM
  const savedBgmName = localStorage.getItem('my_bgm_filename');
  const savedBgmType = localStorage.getItem('my_bgm_type');
  if (savedBgmName && savedBgmType) {
    avatarDB.get('my_bgm').then(buffer => {
      if (buffer) {
        console.log('[LocalCache] Restored saved BGM:', savedBgmName);
        playBgmFromBuffer(buffer, savedBgmType);
      }
    });
  }
}


function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const extension = file.name.split('.').pop()?.toLowerCase();

  loadingOverlay.classList.remove('hidden');
  statusDisplay.innerText = `${file.name} を読み込み中...`;

  // Read model file as ArrayBuffer and share via Socket.io
  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target?.result as ArrayBuffer;
    // Cache the uploaded avatar data locally
    localAvatarCache = {
      fileName: file.name,
      type: extension === 'vrm' ? 'vrm' : 'fbx',
      buffer: arrayBuffer
    };
    
    // Save to IndexedDB so it's remembered next time
    avatarDB.set('my_avatar', arrayBuffer).then(() => {
      localStorage.setItem('my_avatar_filename', file.name);
      localStorage.setItem('my_avatar_type', extension === 'vrm' ? 'vrm' : 'fbx');
    });
    
    if (socket && socket.connected) {
      console.log(`[Network] Sharing avatar model: ${file.name} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      socket.emit('avatar-share', localAvatarCache);
    }
  };
  reader.readAsArrayBuffer(file);

  if (extension === 'vrm') {
    loadVRM(url, file.name);
  } else if (extension === 'fbx') {
    loadFBX(url, file.name);
  } else {
    statusDisplay.innerText = '未対応のファイル形式です。';
    loadingOverlay.classList.add('hidden');
    URL.revokeObjectURL(url);
  }
}

function updateAvatarSelector() {
  const selectorGroup = document.getElementById('avatar-selector-group') as HTMLDivElement;
  const selectEl = document.getElementById('avatar-select') as HTMLSelectElement;
  if (!selectorGroup || !selectEl) return;

  if (loadedAvatars.length >= 2) {
    selectorGroup.style.display = 'block';
  } else {
    selectorGroup.style.display = 'none';
  }

  selectEl.innerHTML = '';
  loadedAvatars.forEach((avatar, index) => {
    const option = document.createElement('option');
    option.value = index.toString();
    option.textContent = `${index + 1}: ${avatar.name}`;
    if (index === activeAvatarIndex) {
      option.selected = true;
    }
    selectEl.appendChild(option);
  });
}

function switchActiveAvatar(index: number) {
  if (index < 0 || index >= loadedAvatars.length) return;
  activeAvatarIndex = index;

  const active = loadedAvatars[index];
  if (active.type === 'vrm') {
    currentVrm = active.vrm;
    currentFbx = undefined;
  } else {
    currentVrm = undefined;
    currentFbx = active.fbx;
    if (currentFbx) {
      fbxMixer = new THREE.AnimationMixer(currentFbx);
      if (currentFbx.animations && currentFbx.animations.length > 0) {
        const action = fbxMixer.clipAction(currentFbx.animations[0]);
        action.play();
      }
    }
  }

  // Adjust camera and OrbitControls focus onto the active avatar
  const modelObj = active.type === 'vrm' ? active.vrm?.scene : active.fbx;
  if (modelObj && controls) {
    const box = new THREE.Box3().setFromObject(modelObj);
    const height = box.max.y - box.min.y;
    controls.target.copy(modelObj.position).add(new THREE.Vector3(0, (height > 0 ? height : 1.6) * 0.7, 0));
    controls.update();
  }
}

function loadVRM(url: string, name: string) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  loader.load(
    url,
    (gltf) => {
      const vrm = gltf.userData.vrm as VRM;

      vrm.scene.traverse((obj: THREE.Object3D) => {
        obj.frustumCulled = false;
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
        (obj as any).matrixAutoUpdate = true;
      });

      // Calculate staggered position for multiple avatars
      let initialX = 0;
      if (loadedAvatars.length > 0) {
        const side = loadedAvatars.length % 2 === 0 ? -1 : 1;
        const multiplier = Math.ceil(loadedAvatars.length / 2);
        initialX = side * multiplier * 1.5;
      }
      vrm.scene.position.set(initialX, 0, 0);
      scene.add(vrm.scene);

      if (vrm.lookAt) {
        vrm.lookAt.target = lookAtTarget;
      }

      // Store in loadedAvatars array
      loadedAvatars.push({
        id: Math.random().toString(36).substring(2, 9),
        name: name,
        type: 'vrm',
        vrm: vrm,
        initialX: initialX
      });

      // Select new avatar automatically
      switchActiveAvatar(loadedAvatars.length - 1);
      updateAvatarSelector();

      statusDisplay.innerText = `${name} のロード完了！`;
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    },
    undefined,
    (error) => {
      console.error(error);
      statusDisplay.innerText = 'VRMのロード中にエラーが発生しました。';
      loadingOverlay.classList.add('hidden');
    }
  );
}

function loadFBX(url: string, name: string) {
  const loader = new FBXLoader();
  loader.load(
    url,
    (object) => {
      object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      object.scale.set(0.01, 0.01, 0.01);

      // Calculate staggered position
      let initialX = 0;
      if (loadedAvatars.length > 0) {
        const side = loadedAvatars.length % 2 === 0 ? -1 : 1;
        const multiplier = Math.ceil(loadedAvatars.length / 2);
        initialX = side * multiplier * 1.5;
      }
      object.position.set(initialX, 0, 0);
      scene.add(object);

      // Store in loadedAvatars array
      loadedAvatars.push({
        id: Math.random().toString(36).substring(2, 9),
        name: name,
        type: 'fbx',
        fbx: object,
        initialX: initialX
      });

      // Select new avatar automatically
      switchActiveAvatar(loadedAvatars.length - 1);
      updateAvatarSelector();

      statusDisplay.innerText = `${name} のロード完了！`;
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    },
    undefined,
    (error) => {
      console.error(error);
      statusDisplay.innerText = 'FBXのロード中にエラーが発生しました。';
      loadingOverlay.classList.add('hidden');
    }
  );
}


/* ============================
 * INTERACTIONS & CONTROLS
 * ============================ */

function onMouseMove(event: MouseEvent) {
  // If camera tracking is active, don't use mouse for head rotation
  if (!lookAtMouseCheckbox.checked || isCameraTracking) return;

  const x = (event.clientX / window.innerWidth) * 2 - 1;
  const y = -(event.clientY / window.innerHeight) * 2 + 1;
  const headHeight = camera.position.y;
  lookAtTarget.position.set(x * 2.0, headHeight + y * 2.0, 3);
}

function onClick(event: MouseEvent) {
  if (event.target !== renderer.domElement || isCameraTracking) return;
  // Click to look at exactly
  const x = (event.clientX / window.innerWidth) * 2 - 1;
  const y = -(event.clientY / window.innerHeight) * 2 + 1;
  lookAtTarget.position.set(x * 5, y * 5 + 1.5, 3);
}

function onKeyDown(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (keys.hasOwnProperty(k)) keys[k as keyof typeof keys] = true;
  
  if (e.code === 'Space' && !isJumping) {
    jumpVelocity = 4.0;
    isJumping = true;
  }

  // Handle Expressions for VRM (Keys 1-5)
  if (currentVrm && currentVrm.expressionManager) {
    if (e.key === '1') setExpression('happy');
    if (e.key === '2') setExpression('angry');
    if (e.key === '3') setExpression('sad');
    if (e.key === '4') setExpression('relaxed');
    if (e.key === '5') setExpression('neutral');
  }
}

function onKeyUp(e: KeyboardEvent) {
  const k = e.key.toLowerCase();
  if (keys.hasOwnProperty(k)) keys[k as keyof typeof keys] = false;
}

function setExpression(name: string) {
  if (!currentVrm || !currentVrm.expressionManager) return;
  const expressions = ['happy', 'angry', 'sad', 'relaxed', 'neutral'];
  expressions.forEach(exp => {
    currentVrm!.expressionManager!.setValue(exp, 0);
  });
  if (name !== 'neutral') {
    currentVrm.expressionManager.setValue(name, 1);
  }
}

/* ============================
 * WEBCAM & MEDIAPIPE TRACKING
 * ============================ */

async function toggleWebcam() {
  if (isCameraTracking) {
    stopWebcam();
  } else {
    startWebcam();
  }
}

function startWebcam() {
  isCameraTracking = true;
  webcamBtn.classList.add('active');
  webcamBtn.innerHTML = '<span>🛑 カメラトラッキング停止</span>';
  videoElement.style.display = 'block';
  statusDisplay.innerText = 'カメラを初期化中...';

  if (!faceMesh) {
    faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    faceMesh.onResults(onFaceResults);
  }

  if (!cameraManager) {
    cameraManager = new Camera(videoElement, {
      onFrame: async () => {
        await faceMesh.send({ image: videoElement });
      },
      width: 320,
      height: 240
    });
  }
  cameraManager.start();
}

function stopWebcam() {
  isCameraTracking = false;
  webcamBtn.classList.remove('active');
  webcamBtn.innerHTML = '<span>📷 カメラトラッキング開始</span>';
  videoElement.style.display = 'none';
  if (cameraManager) {
    cameraManager.stop();
  }
  statusDisplay.innerText = 'カメラ停止';
  
  // Reset VRM head
  if (currentVrm) {
    const head = currentVrm.humanoid.getRawBoneNode('head');
    if (head) head.rotation.set(0, 0, 0);
  }
}

function onFaceResults(results: any) {
  if (!currentVrm || !isCameraTracking) return;

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const faceLandmarks = results.multiFaceLandmarks[0];
    
    // Use Kalidokit to solve face tracking
    const riggedFace = Kalidokit.Face.solve(faceLandmarks, {
      runtime: 'mediapipe',
      video: videoElement
    });

    if (riggedFace) {
      applyFaceTracking(riggedFace);
    }
  }
}

function applyFaceTracking(riggedFace: any) {
  if (!currentVrm) return;

  // 1. Head Rotation
  const headNode = currentVrm.humanoid.getRawBoneNode('head');
  const neckNode = currentVrm.humanoid.getRawBoneNode('neck');
  if (headNode) {
    // Kalidokit gives euler angles in radians, but we might need to adjust axes
    // X = Pitch, Y = Yaw, Z = Roll
    const damp = 0.8; // Dampen the movement a bit
    headNode.rotation.x = riggedFace.head.x * damp;
    headNode.rotation.y = riggedFace.head.y * damp;
    headNode.rotation.z = riggedFace.head.z * damp;
    
    // Spread some rotation to neck
    if (neckNode) {
        neckNode.rotation.x = riggedFace.head.x * (1 - damp);
        neckNode.rotation.y = riggedFace.head.y * (1 - damp);
        neckNode.rotation.z = riggedFace.head.z * (1 - damp);
    }
  }

  // 2. Expressions (Blinking & Mouth)
  if (currentVrm.expressionManager) {
    currentVrm.expressionManager.setValue('blinkLeft', riggedFace.eye.l);
    currentVrm.expressionManager.setValue('blinkRight', riggedFace.eye.r);
    
    // Simple mouth open 'aa' sound
    currentVrm.expressionManager.setValue('aa', riggedFace.mouth.y);
  }
}

/* ============================
 * ANIMATION LOOP
 * ============================ */

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);

  try {
    const delta = clock.getDelta();
    // Move the Sun (mainLight) across the sky (Day/Night Cycle)
    const sunBaseSpeed = 8.0; // Base degrees per second
    if (sunSpeedFactor > 0) {
      sunTimeAngle = (sunTimeAngle + delta * sunBaseSpeed * sunSpeedFactor) % 360;
      
      // Sync UI slider and label when auto-moving
      const sunTimeSlider = document.getElementById('sun-time') as HTMLInputElement;
      const valSunTime = document.getElementById('val-sun-time') as HTMLSpanElement;
      if (sunTimeSlider) sunTimeSlider.value = Math.round(sunTimeAngle).toString();
      if (valSunTime) valSunTime.textContent = Math.round(sunTimeAngle).toString();
    }

    const sunAngleRad = THREE.MathUtils.degToRad(sunTimeAngle);
    const sunRadius = 30;  // Orbit radius
    
    // Orbit the sun in a circle
    mainLight.position.x = Math.cos(sunAngleRad) * sunRadius;
    mainLight.position.y = Math.sin(sunAngleRad) * sunRadius;
    mainLight.position.z = Math.sin(sunAngleRad * 0.5) * sunRadius;
    
    // Keep the visual Sun Sphere matching the light's position
    sunSphere.position.copy(mainLight.position);

    // Adjust light color & intensity based on height (Day/Night Cycle)
    const sunHeight = mainLight.position.y;
    if (sunHeight > 0) {
      // Day / Golden Hour
      const ratio = THREE.MathUtils.clamp(sunHeight / sunRadius, 0, 1);
      
      // Lighter during peak noon, warmer/softer at horizon
      mainLight.intensity = THREE.MathUtils.mapLinear(ratio, 0, 1, 0.4, 2.5);
      
      if (isCustomSunColor) {
        mainLight.color.copy(customSunColor);
        (sunSphere.material as THREE.MeshBasicMaterial).color.copy(customSunColor);
      } else {
        // HSL: interpolate from orange/red (0.05) to light yellow (0.13)
        mainLight.color.setHSL(0.05 + ratio * 0.08, 1.0, 0.55 + ratio * 0.25);
        // Make the sun sphere look bright yellow-white
        (sunSphere.material as THREE.MeshBasicMaterial).color.setHSL(0.08 + ratio * 0.05, 1.0, 0.7);
      }
    } else {
      // Night (cool dim moonlight)
      const ratio = THREE.MathUtils.clamp(-sunHeight / sunRadius, 0, 1);
      mainLight.intensity = THREE.MathUtils.mapLinear(ratio, 0, 1, 0.4, 0.15);
      
      if (isCustomSunColor) {
        // Dim custom color at night
        mainLight.color.copy(customSunColor).multiplyScalar(0.25);
        (sunSphere.material as THREE.MeshBasicMaterial).color.copy(customSunColor).multiplyScalar(0.15);
      } else {
        mainLight.color.setRGB(0.2, 0.25, 0.4); // Dark blue moonlight
        // Dim the sun sphere into a dark blue/gray
        (sunSphere.material as THREE.MeshBasicMaterial).color.setRGB(0.1, 0.12, 0.2);
      }
    }

    // Handle Model Movement
    let modelObj = currentVrm ? currentVrm.scene : (currentFbx ? currentFbx : null);
    if (modelObj) {
      const moveSpeed = 2.0 * delta;
      
      // Calculate camera-relative movement
      const camForward = new THREE.Vector3();
      camera.getWorldDirection(camForward);
      camForward.y = 0;
      if (camForward.lengthSq() > 0.001) {
         camForward.normalize();
      } else {
         camForward.set(0, 0, -1);
      }
      
      const camRight = new THREE.Vector3().crossVectors(camForward, new THREE.Vector3(0, 1, 0)).normalize();

      const moveDir = new THREE.Vector3();
      if (keys.w) moveDir.add(camForward);
      if (keys.s) moveDir.sub(camForward);
      if (keys.a) moveDir.sub(camRight);
      if (keys.d) moveDir.add(camRight);

      if (moveDir.lengthSq() > 0) {
        moveDir.normalize();
        modelObj.position.add(moveDir.clone().multiplyScalar(moveSpeed));
        
        // Align avatar rotation
        const alignDir = currentCameraMode === 'FPS' ? camForward : moveDir;
        const targetAngle = Math.atan2(alignDir.x, alignDir.z);
        
        let diff = targetAngle - modelObj.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        modelObj.rotation.y += diff * 10 * delta;
      } else if (currentCameraMode === 'FPS') {
        // In FPS mode, align body to camera even when not moving
        const targetAngle = Math.atan2(camForward.x, camForward.z);
        let diff = targetAngle - modelObj.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        modelObj.rotation.y += diff * 10 * delta;
      }

      // Handle Jump Physics
      if (isJumping) {
        modelObj.position.y += jumpVelocity * delta;
        jumpVelocity -= 9.8 * delta; // Gravity
        if (modelObj.position.y <= 0) {
          modelObj.position.y = 0;
          isJumping = false;
          jumpVelocity = 0;
        }
      }
    }

    // Auto Rotation
    if (autoRotateCheckbox.checked && modelObj) {
      modelObj.rotation.y += delta * 0.5;
    }

    // --- Update ALL loaded avatars ---
    loadedAvatars.forEach((avatar, index) => {
      const isActive = index === activeAvatarIndex;
      
      if (avatar.type === 'vrm' && avatar.vrm) {
        // Auto Blink (only if camera isn't tracking)
        if (!isCameraTracking) {
          const time = clock.getElapsedTime();
          if (avatar.vrm.expressionManager) {
             const blinkWeight = Math.sin(time * 3 + index) > 0.95 ? 1 : 0; // offset blinking slightly
             avatar.vrm.expressionManager.setValue('blink', blinkWeight);
          }
        }

        if (isActive) {
          // Active VRM (controlled by keyboard or tracking)
          if (!isCameraTracking) {
            if (isJumping) {
              currentAnimState = 'jump';
            } else if (keys.w) {
              currentAnimState = 'walk';
            } else if (keys.s) {
              currentAnimState = 'walkBack';
            } else if (keys.a) {
              currentAnimState = 'strafeLeft';
            } else if (keys.d) {
              currentAnimState = 'strafeRight';
            } else {
              currentAnimState = 'idle';
            }

            const speedMultiplier = 8;
            if (currentAnimState !== 'idle' && currentAnimState !== 'jump') {
              walkTime += delta * speedMultiplier;
            }
            updateProceduralAnimation(avatar.vrm, currentAnimState, walkTime, delta);
          }
        } else {
          // Inactive VRM (plays idle breathing animation)
          updateProceduralAnimation(avatar.vrm, 'idle', 0, delta);
        }

        // Always update the VRM humanoid solver
        avatar.vrm.update(delta);

      } else if (avatar.type === 'fbx' && avatar.fbx) {
        if (isActive && fbxMixer) {
          fbxMixer.update(delta);
        }
      }
    });

    // --- Interpolate remote players ---
    remotePlayers.forEach((rp) => {
      rp.group.position.lerp(rp.targetPos, 0.15);
      rp.group.rotation.y = THREE.MathUtils.lerp(rp.group.rotation.y, rp.targetRotY, 0.15);
      // Billboard name label toward camera
      rp.nameSprite.quaternion.copy(camera.quaternion);

      if (rp.mixer) {
        rp.mixer.update(delta);
      }
    });

    // --- Positional Audio (Distance Attenuation) ---
    const localModel = currentVrm ? currentVrm.scene : currentFbx ?? null;
    const localPos = localModel ? localModel.position : camera.position;
    remotePlayers.forEach((rp, id) => {
      const audioEl = document.getElementById(`audio-${id}`) as HTMLAudioElement;
      if (audioEl && rp.group) {
        const dist = localPos.distanceTo(rp.group.position);
        const maxDist = 15.0; // Audio fadeout distance in meters
        let volume = 1.0 - (dist / maxDist);
        if (volume < 0) volume = 0;
        if (volume > 1) volume = 1;
        audioEl.volume = volume;
      }
    });

    // --- Send local state to server ---
    if (socket && socket.connected) {
      const now = performance.now();
      if (now - lastNetworkSend > SEND_INTERVAL) {
        lastNetworkSend = now;
        const modelObj = currentVrm ? currentVrm.scene : currentFbx ?? null;
        const pos = modelObj ? modelObj.position : new THREE.Vector3();
        const rotY = modelObj ? modelObj.rotation.y : 0;
        socket.emit('state', {
          name: localPlayerName,
          position:  { x: pos.x, y: pos.y, z: pos.z },
          rotationY: rotY,
          boneRots:  { ...boneRotations },
        } satisfies RemotePlayerState);
      }
    }

    // --- Camera Tracking Mode (TPS/FPS) ---
    const activeModel = currentVrm ? currentVrm.scene : currentFbx ?? null;
    if (activeModel) {
      let headPos = new THREE.Vector3();
      let headHeight = 1.4;
      if (currentVrm && currentVrm.humanoid) {
        const headBone = currentVrm.humanoid.getNormalizedBoneNode('head');
        if (headBone) {
          headPos.setFromMatrixPosition(headBone.matrixWorld);
          // Add a tiny forward offset so we don't clip into the face mesh
          const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(activeModel.quaternion);
          headPos.add(forward.multiplyScalar(0.12));
          headHeight = headPos.y - activeModel.position.y;
        }
      } else {
        headPos.copy(activeModel.position).add(new THREE.Vector3(0, headHeight, 0.12));
      }

      if (currentCameraMode === 'TPS') {
        // Smoothly follow the character's upper body in TPS
        const targetPos = activeModel.position.clone().add(new THREE.Vector3(0, headHeight * 0.7, 0));
        controls.target.lerp(targetPos, 0.15);
      } else if (currentCameraMode === 'FPS') {
        // Lock camera to head, target slightly in front for look-around
        const lookDir = new THREE.Vector3();
        camera.getWorldDirection(lookDir);
        camera.position.copy(headPos);
        controls.target.copy(headPos).add(lookDir.multiplyScalar(0.1));
      }
    }

    controls.update();
    renderer.render(scene, camera);
  } catch (err: any) {
    console.error("Animate Loop Error:", err);
    statusDisplay.innerText = `⚠️ 描画エラー: ${err.message || err}`;
    statusDisplay.style.color = '#ff6c8e';
  }
}

/* ============================
 * MULTIPLAYER NETWORK
 * ============================ */

function hashColor(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (id.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

function createNameSprite(name: string, colorHex: number): THREE.Sprite {
  const canvas  = document.createElement('canvas');
  canvas.width  = 320;
  canvas.height = 72;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,12,20,0.75)';
  ctx.fillRect(0, 0, 320, 72);
  const c = new THREE.Color(colorHex);
  ctx.font = 'bold 32px Outfit, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `#${c.getHexString()}`;
  ctx.fillText(name.substring(0, 18), 160, 36);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.4, 0.32, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function createRemotePlayerMesh(id: string, name: string): RemotePlayerObj {
  const colorHex = hashColor(id);
  const color    = new THREE.Color(colorHex);
  const mat      = new THREE.MeshLambertMaterial({ color });
  const group    = new THREE.Group();

  const defaultVisuals = new THREE.Group();

  // Torso
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.5, 4, 8), mat);
  torso.position.y = 0.9;
  defaultVisuals.add(torso);

  // Head
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), mat);
  headMesh.position.y = 1.52;
  defaultVisuals.add(headMesh);

  // Eyes (white dots)
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const lEye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat);
  lEye.position.set(0.07, 1.55, 0.14);
  defaultVisuals.add(lEye);
  const rEye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat);
  rEye.position.set(-0.07, 1.55, 0.14);
  defaultVisuals.add(rEye);

  // Arms
  const armGeo = new THREE.CapsuleGeometry(0.055, 0.38, 4, 8);
  const lArm   = new THREE.Mesh(armGeo, mat);
  lArm.position.set( 0.27, 1.0, 0);
  lArm.rotation.z = 0.35;
  defaultVisuals.add(lArm);
  const rArm = new THREE.Mesh(armGeo, mat);
  rArm.position.set(-0.27, 1.0, 0);
  rArm.rotation.z = -0.35;
  defaultVisuals.add(rArm);

  // Legs
  const legGeo = new THREE.CapsuleGeometry(0.07, 0.48, 4, 8);
  const lLeg   = new THREE.Mesh(legGeo, mat);
  lLeg.position.set( 0.1, 0.34, 0);
  defaultVisuals.add(lLeg);
  const rLeg = new THREE.Mesh(legGeo, mat);
  rLeg.position.set(-0.1, 0.34, 0);
  defaultVisuals.add(rLeg);

  group.add(defaultVisuals);

  // Name label
  const nameSprite = createNameSprite(name || id.substring(0, 8), colorHex);
  nameSprite.position.y = 1.95;
  group.add(nameSprite);

  scene.add(group);

  return {
    group, head: headMesh, nameSprite,
    targetPos: new THREE.Vector3(),
    targetRotY: 0,
    defaultVisuals
  };
}

function setupRemotePlayerAvatar(rp: RemotePlayerObj, avatarData: NonNullable<RemotePlayerState['avatarData']>) {
  const newKey = `${avatarData.fileName}_${avatarData.buffer.byteLength}`;
  if (rp.avatarKey === newKey) {
    return; // Already loaded or loading this exact avatar
  }
  rp.avatarKey = newKey;
  rp.isAvatarLoading = true;

  if (rp.vrm) {
    rp.group.remove(rp.vrm.scene);
    rp.vrm = undefined;
  }
  if (rp.fbx) {
    rp.group.remove(rp.fbx);
    rp.fbx = undefined;
    rp.mixer = undefined;
  }

  // Create Blob URL from the received ArrayBuffer
  const blob = new Blob([avatarData.buffer], { type: 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);

  if (avatarData.type === 'vrm') {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(blobUrl, (gltf) => {
      const vrm = gltf.userData.vrm as VRM;
      vrm.scene.traverse((obj) => {
        obj.frustumCulled = false;
        if ((obj as THREE.Mesh).isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });
      
      if (rp.defaultVisuals) rp.defaultVisuals.visible = false;

      rp.vrm = vrm;
      rp.group.add(vrm.scene);

      // Height adjustment for nameplate
      const head = vrm.humanoid.getNormalizedBoneNode('head');
      const headPos = head ? head.position.y : 1.5;
      rp.nameSprite.position.y = headPos + 0.45;

      rp.isAvatarLoading = false;
      URL.revokeObjectURL(blobUrl);
    }, undefined, (err) => {
      console.error("[Network] Failed to load remote VRM", err);
      rp.isAvatarLoading = false;
      URL.revokeObjectURL(blobUrl);
    });
  } else if (avatarData.type === 'fbx') {
    const loader = new FBXLoader();
    loader.load(blobUrl, (object) => {
      object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      object.scale.set(0.01, 0.01, 0.01);

      if (rp.defaultVisuals) rp.defaultVisuals.visible = false;

      rp.fbx = object;
      rp.group.add(object);

      if (object.animations && object.animations.length > 0) {
        rp.mixer = new THREE.AnimationMixer(object);
        const action = rp.mixer.clipAction(object.animations[0]);
        action.play();
      }

      rp.nameSprite.position.y = 1.95;
      rp.isAvatarLoading = false;
      URL.revokeObjectURL(blobUrl);
    }, undefined, (err) => {
      console.error("[Network] Failed to load remote FBX", err);
      rp.isAvatarLoading = false;
      URL.revokeObjectURL(blobUrl);
    });
  }
}

function applyRemotePlayerState(rp: RemotePlayerObj, state: RemotePlayerState) {
  rp.targetPos.set(state.position.x, state.position.y, state.position.z);
  rp.targetRotY = state.rotationY;

  // Apply VRM bone rotations if model is loaded and we have bone updates
  if (rp.vrm && state.boneRots) {
    const VrmBoneMap: Record<string, string> = {
      lUpperArm: 'leftUpperArm',
      rUpperArm: 'rightUpperArm',
      lLowerArm: 'leftLowerArm',
      rLowerArm: 'rightLowerArm',
      lUpperLeg: 'leftUpperLeg',
      rUpperLeg: 'rightUpperLeg',
      lLowerLeg: 'leftLowerLeg',
      rLowerLeg: 'rightLowerLeg',
      spine: 'spine',
      chest: 'chest',
      hips: 'hips',
    };
    for (const [boneName, rot] of Object.entries(state.boneRots)) {
      const vrmBoneName = VrmBoneMap[boneName] || boneName;
      const bone = rp.vrm.humanoid.getNormalizedBoneNode(vrmBoneName as any);
      if (bone) {
        bone.rotation.set(rot.x, rot.y, rot.z);
      }
    }
  }
}

function applySunSettings(data: { timeAngle: number; speedFactor: number; isCustomColor: boolean; colorHex: string }) {
  sunTimeAngle = data.timeAngle;
  sunSpeedFactor = data.speedFactor;
  isCustomSunColor = data.isCustomColor;
  
  const sunTimeSlider = document.getElementById('sun-time') as HTMLInputElement;
  const sunSpeedSlider = document.getElementById('sun-speed') as HTMLInputElement;
  const sunColorPicker = document.getElementById('sun-color') as HTMLInputElement;
  
  const valSunTime = document.getElementById('val-sun-time') as HTMLSpanElement;
  const valSunSpeed = document.getElementById('val-sun-speed') as HTMLSpanElement;

  if (sunTimeSlider) { sunTimeSlider.value = data.timeAngle.toString(); }
  if (valSunTime) { valSunTime.textContent = data.timeAngle.toString(); }
  if (sunSpeedSlider) { sunSpeedSlider.value = data.speedFactor.toString(); }
  if (valSunSpeed) { valSunSpeed.textContent = data.speedFactor.toFixed(1); }
  
  if (data.isCustomColor) {
    customSunColor.set(data.colorHex);
    if (sunColorPicker) { sunColorPicker.value = data.colorHex; }
  } else {
    if (sunColorPicker) { sunColorPicker.value = '#ffffff'; }
  }
}

function removeRemotePlayer(id: string) {
  const rp = remotePlayers.get(id);
  if (rp) {
    scene.remove(rp.group);
    rp.group.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      const m = (o as THREE.Mesh).material;
      if (m) Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose();
    });
    remotePlayers.delete(id);
  }
}

function initNetwork() {
  // Determine server URL: use port 3001 for local/LAN development, otherwise use the host origin for production
  const serverUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.hostname.startsWith('192.168.')
    ? `http://${window.location.hostname}:3001`
    : `${window.location.protocol}//${window.location.host}`;
    
  socket = io(serverUrl);

  socket.on('connect', () => {
    console.log('[Network] Connected:', socket!.id);
    // 接続後すぐにルームに参加
    socket!.emit('join-room', { room: localRoomName, name: localPlayerName, playerId: localPlayerId });

    // Send cached avatar data immediately upon connection
    if (localAvatarCache) {
      console.log(`[Network] Connected. Auto-sharing cached avatar: ${localAvatarCache.fileName}`);
      socket!.emit('avatar-share', localAvatarCache);
    }
  });

  // ワールド調整値をローカルモデルとスライダーUIに適用するヘルパー関数
  function applyWorldTransform(data: { x: number, y: number, z: number, rY: number, s: number }) {
    if (!currentWorld) return;
    currentWorld.position.set(data.x, data.y, data.z);
    currentWorld.rotation.y = data.rY;
    currentWorld.scale.setScalar(data.s);

    const worldPosX = document.getElementById('world-pos-x') as HTMLInputElement;
    const worldPosY = document.getElementById('world-pos-y') as HTMLInputElement;
    const worldPosZ = document.getElementById('world-pos-z') as HTMLInputElement;
    const worldRotY = document.getElementById('world-rot-y') as HTMLInputElement;
    const worldScale = document.getElementById('world-scale') as HTMLInputElement;

    const valWorldX = document.getElementById('val-world-x') as HTMLSpanElement;
    const valWorldY = document.getElementById('val-world-y') as HTMLSpanElement;
    const valWorldZ = document.getElementById('val-world-z') as HTMLSpanElement;
    const valWorldRotY = document.getElementById('val-world-roty') as HTMLSpanElement;
    const valWorldScale = document.getElementById('val-world-scale') as HTMLSpanElement;

    if (worldPosX) { worldPosX.value = data.x.toString(); valWorldX.textContent = data.x.toFixed(1); }
    if (worldPosY) { worldPosY.value = data.y.toString(); valWorldY.textContent = data.y.toFixed(1); }
    if (worldPosZ) { worldPosZ.value = data.z.toString(); valWorldZ.textContent = data.z.toFixed(1); }
    if (worldRotY) { worldRotY.value = Math.round(THREE.MathUtils.radToDeg(data.rY)).toString(); valWorldRotY.textContent = worldRotY.value; }
    if (worldScale) { worldScale.value = data.s.toString(); valWorldScale.textContent = data.s.toFixed(2); }
  }

  socket.on('room-joined', ({ room, playerCount, environment, chatHistory }: { room: string; playerCount: number; environment?: any; chatHistory?: { id: string, name: string, text: string }[] }) => {
    updateNetworkStatus(true, room, playerCount);
    console.log(`[Network] Joined room: ${room} (${playerCount} players)`);

    // Show chat area and mic button
    const chatContainer = document.getElementById('chat-container');
    const micBtn = document.getElementById('mic-btn');
    const chatMessages = document.getElementById('chat-messages');

    if (chatContainer) chatContainer.style.display = 'flex';
    if (micBtn) micBtn.style.display = 'block';

    // 入室時にチャット履歴をクリア
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }

    appendChatMessage('システム', `🟢 ルーム [${room}] に接続しました。`, true);

    // 過去のチャット履歴（掲示板）を表示
    if (chatHistory && chatHistory.length > 0) {
      appendChatMessage('システム', '--- 過去のメッセージ ---', true);
      chatHistory.forEach(msg => {
        appendChatMessage(msg.name, msg.text);
      });
      appendChatMessage('システム', '------------------------', true);
    }

    // Apply environment if it exists (meaning a host has already loaded something)
    if (environment) {
      // 1. Apply world transform
      if (environment.worldTransform) {
        applyWorldTransform(environment.worldTransform);
      }
      
      // 2. Apply sun settings
      if (environment.sunSettings) {
        applySunSettings(environment.sunSettings);
      }

      // 3. Load world model
      if (environment.worldData) {
        const wd = environment.worldData;
        console.log(`[Network] Loading host world: ${wd.fileName}`);
        const blob = new Blob([wd.buffer], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        loadingOverlay.classList.remove('hidden');
        statusDisplay.innerText = `ホストのワールド (${wd.fileName}) をロード中...`;
        if (wd.type === 'glb' || wd.type === 'gltf') {
          loadWorldGLTF(url);
        } else {
          loadWorldFBX(url);
        }
      } else {
        // Room has no world, share our cached world if we have one
        const savedWorldName = localStorage.getItem('my_world_filename');
        const savedWorldType = localStorage.getItem('my_world_type');
        if (savedWorldName && savedWorldType) {
          avatarDB.get('my_world').then(buffer => {
            if (buffer && socket && socket.connected) {
              console.log(`[Network] Auto-sharing cached world: ${savedWorldName}`);
              socket.emit('world-share', {
                fileName: savedWorldName,
                type: savedWorldType,
                buffer: buffer
              });
            }
          });
        }
      }

      // 3.5 Load BGM
      if (environment.bgmData) {
        const bd = environment.bgmData;
        console.log(`[Network] Loading host BGM: ${bd.fileName}`);
        playBgmFromBuffer(bd.buffer, bd.type || 'audio/mpeg');
      } else {
        // Room has no BGM, share our cached BGM if we have one
        const savedBgmName = localStorage.getItem('my_bgm_filename');
        const savedBgmType = localStorage.getItem('my_bgm_type');
        if (savedBgmName && savedBgmType) {
          avatarDB.get('my_bgm').then(buffer => {
            if (buffer && socket && socket.connected) {
              console.log(`[Network] Auto-sharing cached BGM: ${savedBgmName}`);
              socket.emit('bgm-share', {
                fileName: savedBgmName,
                type: savedBgmType,
                buffer: buffer
              });
            }
          });
        }
      }
      // 4. Load skybox background
      if (environment.skyboxData) {
        const sd = environment.skyboxData;
        console.log(`[Network] Loading host skybox: ${sd.fileName}`);
        const blob = new Blob([sd.buffer], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        
        const loader = new THREE.TextureLoader();
        loader.load(url, (texture) => {
          if (skyboxTexture) skyboxTexture.dispose();
          skyboxTexture = texture;
          skyboxTexture.mapping = THREE.EquirectangularReflectionMapping;
          skyboxTexture.colorSpace = THREE.SRGBColorSpace;
          scene.background = skyboxTexture;
          scene.environment = skyboxTexture;
          URL.revokeObjectURL(url);
        }, undefined, (err) => {
          console.error(err);
          URL.revokeObjectURL(url);
        });
      }
    } else {
      // No environment at all, share our cached world if we have one
      const savedWorldName = localStorage.getItem('my_world_filename');
      const savedWorldType = localStorage.getItem('my_world_type');
      if (savedWorldName && savedWorldType) {
        avatarDB.get('my_world').then(buffer => {
          if (buffer && socket && socket.connected) {
            console.log(`[Network] Auto-sharing cached world: ${savedWorldName}`);
            socket.emit('world-share', {
              fileName: savedWorldName,
              type: savedWorldType,
              buffer: buffer
            });
          }
        });
      }

      const savedBgmName = localStorage.getItem('my_bgm_filename');
      const savedBgmType = localStorage.getItem('my_bgm_type');
      if (savedBgmName && savedBgmType) {
        avatarDB.get('my_bgm').then(buffer => {
          if (buffer && socket && socket.connected) {
            console.log(`[Network] Auto-sharing cached BGM: ${savedBgmName}`);
            socket.emit('bgm-share', {
              fileName: savedBgmName,
              type: savedBgmType,
              buffer: buffer
            });
          }
        });
      }
    }
  });
 
  socket.on('disconnect', () => {
    console.log('[Network] Disconnected');
    updateNetworkStatus(false);
    remotePlayers.forEach((_, id) => removeRemotePlayer(id));

    // Hide chat area and mic button
    const chatContainer = document.getElementById('chat-container');
    const micBtn = document.getElementById('mic-btn');
    if (chatContainer) chatContainer.style.display = 'none';
    if (micBtn) micBtn.style.display = 'none';

    stopLocalStream();
    peerConnections.forEach((_, pid) => closePeerConnection(pid));
  });
 
  // 既存プレイヤー一覧を受信
  socket.on('init', (players: Array<{ id: string, avatarInfo?: any } & RemotePlayerState>) => {
    players.forEach(({ id, avatarInfo, ...state }) => {
      if (!remotePlayers.has(id)) {
        remotePlayers.set(id, createRemotePlayerMesh(id, state.name));
      }
      applyRemotePlayerState(remotePlayers.get(id)!, state);

      if (avatarInfo) {
        handleAvatarInfo(id, avatarInfo);
      }

      // Establish WebRTC connection with existing players
      initiateWebRTCPeer(id);
      sendWebRTCOffer(id);
    });
  });
 
  // 新規参加
  socket.on('player-joined', ({ id }: { id: string }) => {
    if (!remotePlayers.has(id)) {
      remotePlayers.set(id, createRemotePlayerMesh(id, id.substring(0, 8)));
    }
    // Setup WebRTC and send offer to new player
    initiateWebRTCPeer(id);
    sendWebRTCOffer(id);

    appendChatMessage('システム', `📢 プレイヤー ${id.substring(0, 8)} が入室しました。`, true);
  });
 
  // 状態更新
  socket.on('player-state', ({ id, ...state }: { id: string } & RemotePlayerState) => {
    if (!remotePlayers.has(id)) {
      remotePlayers.set(id, createRemotePlayerMesh(id, state.name));
    }
    applyRemotePlayerState(remotePlayers.get(id)!, state);
  });

  // 退出
  socket.on('player-left', ({ id }: { id: string }) => {
    removeRemotePlayer(id);
  });

  // 他プレイヤーからアバター情報が共有された場合
  socket.on('avatar-info', ({ id, fileName, type, size }: { id: string, fileName: string, type: 'vrm'|'fbx', size: number }) => {
    let rp = remotePlayers.get(id);
    if (!rp) {
      rp = createRemotePlayerMesh(id, id.substring(0, 8));
      remotePlayers.set(id, rp);
    }
    handleAvatarInfo(id, { fileName, type, size });
  });

  socket.on('avatar-buffer-response', async (data: { id: string, fileName: string, type: 'vrm'|'fbx', buffer: ArrayBuffer }) => {
    const cacheKey = `${data.fileName}_${data.buffer.byteLength}`;
    await avatarDB.set(cacheKey, data.buffer);
    let rp = remotePlayers.get(data.id);
    if (rp) {
      setupRemotePlayerAvatar(rp, data);
    }
  });

  async function handleAvatarInfo(id: string, info: { fileName: string, type: 'vrm'|'fbx', size: number }) {
    const cacheKey = `${info.fileName}_${info.size}`;
    const rp = remotePlayers.get(id);
    if (!rp) return;
    
    // Check if we are already loading this avatar
    if (rp.avatarKey === cacheKey && rp.isAvatarLoading) return;
    
    const cachedBuffer = await avatarDB.get(cacheKey);
    if (cachedBuffer) {
      console.log(`[Network] Found cached avatar for ${id}: ${info.fileName}`);
      setupRemotePlayerAvatar(rp, { fileName: info.fileName, type: info.type, buffer: cachedBuffer });
    } else {
      console.log(`[Network] Requesting avatar buffer for ${id}: ${info.fileName}`);
      socket?.emit('request-avatar-buffer', id);
    }
  }

  // 他のプレイヤーがワールド調整（位置、回転、スケール）を操作した際に受け取る
  socket.on('world-transformed', (data: { x: number, y: number, z: number, rY: number, s: number }) => {
    applyWorldTransform(data);
  });

  // 他のプレイヤーからワールドモデルデータが共有された場合
  socket.on('world-shared', ({ fileName, type, buffer }: { fileName: string; type: string; buffer: ArrayBuffer }) => {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    
    loadingOverlay.classList.remove('hidden');
    statusDisplay.innerText = `他プレイヤーのワールド (${fileName}) をロード中...`;
    
    if (type === 'glb' || type === 'gltf') {
      loadWorldGLTF(url);
    } else {
      loadWorldFBX(url);
    }
  });

  // 他のプレイヤーからBGMが共有された場合
  socket.on('bgm-shared', ({ fileName, type, buffer }: { fileName: string; type: string; buffer: ArrayBuffer }) => {
    console.log(`[Network] Remote BGM received: ${fileName}`);
    playBgmFromBuffer(buffer, type || 'audio/mpeg');
  });

  // 他のプレイヤーからスカイボックス画像データが共有された場合
  socket.on('skybox-shared', ({ fileName, buffer }: { fileName: string; buffer: ArrayBuffer }) => {
    const blob = new Blob([buffer], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    
    loadingOverlay.classList.remove('hidden');
    statusDisplay.innerText = `他プレイヤーの背景画像 (${fileName}) をロード中...`;
    
    const loader = new THREE.TextureLoader();
    loader.load(url, (texture) => {
      if (skyboxTexture) skyboxTexture.dispose();
      skyboxTexture = texture;
      skyboxTexture.mapping = THREE.EquirectangularReflectionMapping;
      skyboxTexture.colorSpace = THREE.SRGBColorSpace;
      scene.background = skyboxTexture;
      scene.environment = skyboxTexture;
      
      statusDisplay.innerText = '背景画像の同期が完了しました！';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    }, undefined, (err) => {
      console.error(err);
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    });
  });

  // 他のプレイヤーから太陽と時間設定が変更された場合
  socket.on('sun-settings-shared', (data: any) => {
    applySunSettings(data);
  });

  // チャットメッセージを受信
  socket.on('chat-msg', ({ name, text }: { id: string; name: string; text: string }) => {
    appendChatMessage(name, text);
  });

  // WebRTC シグナリングハンドリング
  socket.on('webrtc-offer', async ({ from, offer }: { from: string; offer: any }) => {
    console.log(`[WebRTC] Received offer from ${from}`);
    let pci = peerConnections.get(from);
    if (!pci) {
      initiateWebRTCPeer(from);
      pci = peerConnections.get(from)!;
    }

    try {
      await pci.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pci.pc.createAnswer();
      await pci.pc.setLocalDescription(answer);
      socket!.emit('webrtc-answer', { to: from, answer });
    } catch (err) {
      console.error('Answerの作成に失敗しました:', err);
    }
  });

  socket.on('webrtc-answer', async ({ from, answer }: { from: string; answer: any }) => {
    console.log(`[WebRTC] Received answer from ${from}`);
    const pci = peerConnections.get(from);
    if (pci) {
      try {
        await pci.pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Answerの適用に失敗しました:', err);
      }
    }
  });

  socket.on('webrtc-candidate', async ({ from, candidate }: { from: string; candidate: any }) => {
    const pci = peerConnections.get(from);
    if (pci) {
      try {
        await pci.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE Candidateの追加に失敗しました:', err);
      }
    }
  });
}

function disconnectNetwork() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  remotePlayers.forEach((_, id) => removeRemotePlayer(id));
  updateNetworkStatus(false);

  // Hide chat and mic buttons
  const chatContainer = document.getElementById('chat-container');
  const micBtn = document.getElementById('mic-btn');
  if (chatContainer) chatContainer.style.display = 'none';
  if (micBtn) {
    micBtn.style.display = 'none';
    micBtn.textContent = '🎤 マイク: OFF';
    micBtn.style.background = 'rgba(255, 108, 142, 0.1)';
    micBtn.style.color = '#ff6c8e';
    micBtn.style.borderColor = 'rgba(255, 108, 142, 0.25)';
  }
  isMicActive = false;

  // Stop WebRTC audio and close connections
  stopLocalStream();
  peerConnections.forEach((_, id) => closePeerConnection(id));
}

function updateNetworkStatus(connected: boolean, room?: string, count?: number) {
  const el = document.getElementById('network-status');
  if (el) {
    if (connected && room) {
      el.textContent = `🟢 ${room} (${count}人)`;
      el.style.color = '#6cffb4';
    } else if (connected) {
      el.textContent = '🟢 接続中';
      el.style.color = '#6cffb4';
    } else {
      el.textContent = '🔴 未接続';
      el.style.color = '#ff6c8e';
    }
  }
}

// Store current normalized bone rotation values for smooth lerping
const boneRotations: Record<string, { x: number; y: number; z: number }> = {};

function getBoneRot(key: string) {
  if (!boneRotations[key]) boneRotations[key] = { x: 0, y: 0, z: 0 };
  return boneRotations[key];
}

function updateProceduralAnimation(vrm: VRM, state: string, time: number, delta: number) {
  const h = vrm.humanoid;
  if (!h) return; // Guard in case humanoid is undefined


  // Use getNormalizedBoneNode for VRM1.0 — this is what vrm.update() reads.
  // getRawBoneNode returns the raw skeleton bone which vrm.update() overwrites.
  const bones = {
    lUpperArm: h.getNormalizedBoneNode('leftUpperArm'),
    rUpperArm: h.getNormalizedBoneNode('rightUpperArm'),
    lLowerArm: h.getNormalizedBoneNode('leftLowerArm'),
    rLowerArm: h.getNormalizedBoneNode('rightLowerArm'),
    lUpperLeg: h.getNormalizedBoneNode('leftUpperLeg'),
    rUpperLeg: h.getNormalizedBoneNode('rightUpperLeg'),
    lLowerLeg: h.getNormalizedBoneNode('leftLowerLeg'),
    rLowerLeg: h.getNormalizedBoneNode('rightLowerLeg'),
    spine:     h.getNormalizedBoneNode('spine'),
    chest:     h.getNormalizedBoneNode('chest'),
    hips:      h.getNormalizedBoneNode('hips'),
  };

  const elapsed = clock.getElapsedTime();

  // --- Build target rotations (x, y, z) per bone ---
  // Defaults = natural idle / A-pose in normalized space
  const tgt: Record<string, { x: number; y: number; z: number }> = {
    lUpperArm: { x: 0.1,  y: 0, z: -1.25 },  // A-pose: arms down and slightly forward
    rUpperArm: { x: 0.1,  y: 0, z:  1.25 },
    lLowerArm: { x: 0.2,  y: 0, z:  0    },  // slightly bent elbows
    rLowerArm: { x: 0.2,  y: 0, z:  0    },
    lUpperLeg: { x: 0,    y: 0, z:  0    },
    rUpperLeg: { x: 0,    y: 0, z:  0    },
    lLowerLeg: { x: 0,    y: 0, z:  0    },
    rLowerLeg: { x: 0,    y: 0, z:  0    },
    spine:     { x: 0.02, y: 0, z:  0    },
    chest:     { x: 0.02, y: 0, z:  0    },
    hips:      { x: 0,    y: 0, z:  0    },
  };

  if (state === 'idle') {
    // Breathing cycle
    const breathe = Math.sin(elapsed * 1.8);
    
    // Breathing movement on torso
    tgt.chest.x = 0.02 + breathe * 0.012;
    tgt.spine.x = 0.02 + breathe * 0.005;
    
    // Arm breathing sway
    tgt.lUpperArm.z = -1.25 + breathe * 0.015;
    tgt.rUpperArm.z =  1.25 - breathe * 0.015;
    tgt.lUpperArm.x =  0.1 + breathe * 0.008;
    tgt.rUpperArm.x =  0.1 + breathe * 0.008;
    
    // Elbow breathing sway
    tgt.lLowerArm.x = 0.2 + breathe * 0.01;
    tgt.rLowerArm.x = 0.2 + breathe * 0.01;
    
    // Subtle hip breathing sway
    tgt.hips.y = breathe * 0.003;
    tgt.hips.x = breathe * 0.002;

  } else if (state === 'walk' || state === 'walkBack') {
    const dir = state === 'walk' ? 1 : -1;
    // Arm swing (opposite to legs)
    tgt.lUpperArm.x = Math.sin(time + Math.PI) * 0.5 * dir;
    tgt.rUpperArm.x = Math.sin(time)           * 0.5 * dir;
    // Elbow bend during swing
    tgt.lLowerArm.x = Math.max(0, Math.sin(time + Math.PI)) * 0.4;
    tgt.rLowerArm.x = Math.max(0, Math.sin(time))           * 0.4;
    // Leg stride
    tgt.lUpperLeg.x = Math.sin(time)           * 0.6 * dir;
    tgt.rUpperLeg.x = Math.sin(time + Math.PI) * 0.6 * dir;
    // Knee bend (always positive — leg bends backward)
    tgt.lLowerLeg.x = Math.max(0, -Math.sin(time))           * 0.9;
    tgt.rLowerLeg.x = Math.max(0, -Math.sin(time + Math.PI)) * 0.9;
    // Hip sway and spine counter-rotate for natural look
    tgt.hips.z  = Math.sin(time * 2) * 0.04;
    tgt.spine.z = -Math.sin(time * 2) * 0.03;
    tgt.spine.x = 0.05; // slight forward lean
    tgt.chest.x = state === 'walkBack' ? -0.06 : 0.04;

  } else if (state === 'strafeLeft' || state === 'strafeRight') {
    const dir = state === 'strafeLeft' ? 1 : -1;
    tgt.lUpperArm.z = 0.4 + dir * 0.4;
    tgt.rUpperArm.z = -0.4 + dir * 0.4;
    tgt.lUpperLeg.z = Math.sin(time) * 0.25 * dir;
    tgt.rUpperLeg.z = Math.sin(time) * 0.25 * dir;
    tgt.spine.z     = dir * 0.05;

  } else if (state === 'jump') {
    tgt.lUpperArm.z =  1.8;  // arms raised
    tgt.rUpperArm.z = -1.8;
    tgt.lUpperArm.x = -0.2;
    tgt.rUpperArm.x = -0.2;
    tgt.lUpperLeg.x = -0.25; // legs slightly bent back
    tgt.rUpperLeg.x = -0.25;
    tgt.lLowerLeg.x =  0.5;
    tgt.rLowerLeg.x =  0.5;
    tgt.spine.x     = -0.05;
  }

  // Lerp stored rotations toward targets, then apply to normalized bones
  const speed = state === 'jump' ? 14 : 9;
  for (const key of Object.keys(tgt)) {
    const bone = (bones as any)[key] as THREE.Object3D | null;
    if (!bone) continue;

    const cur = getBoneRot(key);
    cur.x = THREE.MathUtils.lerp(cur.x, tgt[key].x, delta * speed);
    cur.y = THREE.MathUtils.lerp(cur.y, tgt[key].y, delta * speed);
    cur.z = THREE.MathUtils.lerp(cur.z, tgt[key].z, delta * speed);

    bone.rotation.x = cur.x;
    bone.rotation.y = cur.y;
    bone.rotation.z = cur.z;
  }
}

/* ============================
 * 3D WORLD BUILDERS & LOADERS
 * ============================ */

function buildDefaultWorld() {
  if (defaultWorldGroup) {
    scene.remove(defaultWorldGroup);
  }
  defaultWorldGroup = new THREE.Group();

  // 1. Cyber stage floor (circle)
  const stageGeo = new THREE.CylinderGeometry(12, 12, 0.2, 32);
  const stageMat = new THREE.MeshStandardMaterial({
    color: 0x111625,
    roughness: 0.2,
    metalness: 0.8,
  });
  const stage = new THREE.Mesh(stageGeo, stageMat);
  stage.position.y = -0.1;
  stage.receiveShadow = true;
  defaultWorldGroup.add(stage);

  // Grid on top of the stage
  const gridHelper = new THREE.GridHelper(24, 24, 0x6c8eff, 0x24344f);
  gridHelper.position.y = 0.01;
  defaultWorldGroup.add(gridHelper);

  // 2. Neon ring around the stage
  const ringGeo = new THREE.RingGeometry(11.8, 12, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x6c8eff,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  defaultWorldGroup.add(ring);

  // 3. Cyber pillars (neon cylinders)
  const pillarColor = [0x6c8eff, 0xff6c8e, 0x6cffb4];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const radius = 15;
    const height = 4 + Math.random() * 6;
    
    const pillarGeo = new THREE.CylinderGeometry(0.3, 0.3, height, 8);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x1f2330,
      roughness: 0.1,
      metalness: 0.9,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    defaultWorldGroup.add(pillar);

    // Neon light strip on top of each pillar
    const capGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.3, 8);
    const capMat = new THREE.MeshBasicMaterial({
      color: pillarColor[i % pillarColor.length],
    });
    const cap = new THREE.Mesh(capGeo, capMat);
    cap.position.set(Math.cos(angle) * radius, height + 0.15, Math.sin(angle) * radius);
    defaultWorldGroup.add(cap);
  }

  // 4. Floating cyber particles
  const particleGeo = new THREE.BufferGeometry();
  const count = 120;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 30;     // X
    positions[i * 3 + 1] = Math.random() * 10;          // Y
    positions[i * 3 + 2] = (Math.random() - 0.5) * 30;  // Z
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particleMat = new THREE.PointsMaterial({
    color: 0x6cffb4,
    size: 0.15,
    transparent: true,
    opacity: 0.6,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  defaultWorldGroup.add(particles);

  scene.add(defaultWorldGroup);
}

function handleWorldUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const extension = file.name.split('.').pop()?.toLowerCase();

  loadingOverlay.classList.remove('hidden');
  statusDisplay.innerText = `${file.name} (ワールド) を読み込み中...`;

  // Read world file as ArrayBuffer and share via Socket.io
  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target?.result as ArrayBuffer;
    const type = extension === 'glb' || extension === 'gltf' ? 'glb' : 'fbx';

    // Save to IndexedDB so it's remembered next time
    avatarDB.set('my_world', arrayBuffer).then(() => {
      localStorage.setItem('my_world_filename', file.name);
      localStorage.setItem('my_world_type', type);
    });

    if (socket && socket.connected) {
      console.log(`[Network] Sharing world model: ${file.name} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      socket.emit('world-share', {
        fileName: file.name,
        type: type,
        buffer: arrayBuffer
      });
    }
  };
  reader.readAsArrayBuffer(file);

  if (extension === 'glb' || extension === 'gltf') {
    loadWorldGLTF(url);
  } else if (extension === 'fbx') {
    loadWorldFBX(url);
  } else {
    statusDisplay.innerText = '未対応のファイル形式です。';
    loadingOverlay.classList.add('hidden');
    URL.revokeObjectURL(url);
  }
}

function clearCurrentWorld() {
  if (currentWorld) {
    scene.remove(currentWorld);
    currentWorld.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      // @ts-ignore
      if (obj.material) {
        // @ts-ignore
        if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
        // @ts-ignore
        else obj.material.dispose();
      }
    });
    currentWorld = undefined;
  }
  if (defaultWorldGroup) {
    defaultWorldGroup.visible = true; // Restore default cyber stage when custom world is cleared
  }

  // Hide the world adjustment UI
  const worldAdjustUi = document.getElementById('world-adjust-ui');
  if (worldAdjustUi) {
    worldAdjustUi.style.display = 'none';
  }
}

function initWorldAdjustUI() {
  const worldAdjustUi = document.getElementById('world-adjust-ui') as HTMLDivElement;
  if (!worldAdjustUi || !currentWorld) return;

  const worldPosX = document.getElementById('world-pos-x') as HTMLInputElement;
  const worldPosY = document.getElementById('world-pos-y') as HTMLInputElement;
  const worldPosZ = document.getElementById('world-pos-z') as HTMLInputElement;
  const worldRotY = document.getElementById('world-rot-y') as HTMLInputElement;
  const worldScale = document.getElementById('world-scale') as HTMLInputElement;

  const valWorldX = document.getElementById('val-world-x') as HTMLSpanElement;
  const valWorldY = document.getElementById('val-world-y') as HTMLSpanElement;
  const valWorldZ = document.getElementById('val-world-z') as HTMLSpanElement;
  const valWorldRotY = document.getElementById('val-world-roty') as HTMLSpanElement;
  const valWorldScale = document.getElementById('val-world-scale') as HTMLSpanElement;

  // Reset sliders to align with the newly loaded model's initial state
  worldPosX.value = "0";
  worldPosY.value = "0";
  worldPosZ.value = "0";
  worldRotY.value = "0";
  
  const initialScale = currentWorld.scale.x;
  worldScale.value = initialScale.toString();

  // Update text labels
  valWorldX.textContent = "0.0";
  valWorldY.textContent = "0.0";
  valWorldZ.textContent = "0.0";
  valWorldRotY.textContent = "0";
  valWorldScale.textContent = initialScale.toFixed(2);

  // Show the adjustment panel
  worldAdjustUi.style.display = 'block';
}

function loadWorldGLTF(url: string) {
  const loader = new GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      clearCurrentWorld();
      currentWorld = gltf.scene;

      currentWorld.traverse((obj: THREE.Object3D) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.receiveShadow = true;
          obj.castShadow = true;
          const mesh = obj as THREE.Mesh;
          if (mesh.material) {
            (mesh.material as any).roughness = 0.8;
          }
        }
        (obj as any).matrixAutoUpdate = true;
      });

      const box = new THREE.Box3().setFromObject(currentWorld);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      
      if (maxDim < 2) {
        currentWorld.scale.setScalar(10);
      }
      
      scene.add(currentWorld);
      if (defaultWorldGroup) {
        defaultWorldGroup.visible = false; // Hide default cyber stage/grid when custom world is loaded
      }
      initWorldAdjustUI(); // Initialize adjustment sliders

      statusDisplay.innerText = 'ワールドの読み込みが完了しました！';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    },
    (xhr) => {
      const percent = Math.round((xhr.loaded / xhr.total) * 100);
      statusDisplay.innerText = `ワールド読み込み中... ${percent}%`;
    },
    (err) => {
      console.error(err);
      statusDisplay.innerText = 'ワールドの読み込みに失敗しました。';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    }
  );
}

function loadWorldFBX(url: string) {
  const loader = new FBXLoader();
  loader.load(
    url,
    (fbx) => {
      clearCurrentWorld();
      currentWorld = fbx;

      currentWorld.traverse((obj: THREE.Object3D) => {
        if ((obj as THREE.Mesh).isMesh) {
          obj.receiveShadow = true;
          obj.castShadow = true;
        }
        (obj as any).matrixAutoUpdate = true;
      });

      const box = new THREE.Box3().setFromObject(currentWorld);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      if (maxDim > 100) {
        currentWorld.scale.setScalar(0.01);
      } else if (maxDim < 2) {
        currentWorld.scale.setScalar(5);
      }

      scene.add(currentWorld);
      if (defaultWorldGroup) {
        defaultWorldGroup.visible = false; // Hide default cyber stage/grid when custom world is loaded
      }
      initWorldAdjustUI(); // Initialize adjustment sliders

      statusDisplay.innerText = 'ワールドの読み込みが完了しました！';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    },
    (xhr) => {
      const percent = Math.round((xhr.loaded / xhr.total) * 100);
      statusDisplay.innerText = `ワールド読み込み中... ${percent}%`;
    },
    (err) => {
      console.error(err);
      statusDisplay.innerText = 'ワールドの読み込みに失敗しました。';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    }
  );
}

function handleSkyboxUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  loadingOverlay.classList.remove('hidden');
  statusDisplay.innerText = `${file.name} (背景画像) を読み込み中...`;

  // Read skybox image as ArrayBuffer and share via Socket.io
  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target?.result as ArrayBuffer;
    if (socket && socket.connected) {
      console.log(`[Network] Sharing skybox: ${file.name} (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      socket.emit('skybox-share', {
        fileName: file.name,
        buffer: arrayBuffer
      });
    }
  };
  reader.readAsArrayBuffer(file);

  const loader = new THREE.TextureLoader();
  loader.load(
    url,
    (texture) => {
      if (skyboxTexture) {
        skyboxTexture.dispose();
      }
      
      skyboxTexture = texture;
      
      // Map it as Equirectangular (360 degree panoramic sphere)
      skyboxTexture.mapping = THREE.EquirectangularReflectionMapping;
      skyboxTexture.colorSpace = THREE.SRGBColorSpace;

      // Apply to background and environment reflection
      scene.background = skyboxTexture;
      scene.environment = skyboxTexture;

      statusDisplay.innerText = '背景画像のロードが完了しました！';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    },
    undefined,
    (err) => {
      console.error(err);
      statusDisplay.innerText = '背景画像のロードに失敗しました。';
      loadingOverlay.classList.add('hidden');
      URL.revokeObjectURL(url);
    }
  );
}

function handleBgmUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  statusDisplay.innerText = `${file.name} (BGM) を読み込み中...`;

  const reader = new FileReader();
  reader.onload = (e) => {
    const arrayBuffer = e.target?.result as ArrayBuffer;
    const type = file.type || 'audio/mpeg';

    // Save to IndexedDB
    avatarDB.set('my_bgm', arrayBuffer).then(() => {
      localStorage.setItem('my_bgm_filename', file.name);
      localStorage.setItem('my_bgm_type', type);
    });

    playBgmFromBuffer(arrayBuffer, type);

    if (socket && socket.connected) {
      console.log(`[Network] Sharing BGM: ${file.name}`);
      socket.emit('bgm-share', {
        fileName: file.name,
        type: type,
        buffer: arrayBuffer
      });
    }
  };
  reader.readAsArrayBuffer(file);
}

let currentBgmUrl: string | null = null;
function playBgmFromBuffer(buffer: ArrayBuffer, type: string) {
  const bgmPlayer = document.getElementById('bgm-player') as HTMLAudioElement;
  if (!bgmPlayer) return;

  if (currentBgmUrl) {
    URL.revokeObjectURL(currentBgmUrl);
  }

  const blob = new Blob([buffer], { type: type });
  currentBgmUrl = URL.createObjectURL(blob);

  bgmPlayer.src = currentBgmUrl;
  
  // Browsers might block autoplay without user interaction
  const playPromise = bgmPlayer.play();
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.warn("BGM autoplay prevented. User interaction required.", error);
      statusDisplay.innerText = "BGM再生のため画面内をクリックしてください";
      
      const playOnInteraction = () => {
        bgmPlayer.play().catch(()=>{});
        document.removeEventListener('click', playOnInteraction);
        document.removeEventListener('touchstart', playOnInteraction);
        statusDisplay.innerText = "準備完了";
      };
      document.addEventListener('click', playOnInteraction);
      document.addEventListener('touchstart', playOnInteraction, { passive: true });
    });
  }
}

// --- Text & Voice Chat Helpers ---
function appendChatMessage(senderName: string, text: string, isSystem = false) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const item = document.createElement('div');
  item.className = 'chat-message-item' + (isSystem ? ' system' : '');
  
  if (isSystem) {
    item.textContent = text;
  } else {
    const senderSpan = document.createElement('span');
    senderSpan.className = 'sender';
    senderSpan.textContent = senderName + ': ';
    item.appendChild(senderSpan);
    
    const textNode = document.createTextNode(text);
    item.appendChild(textNode);
  }
  
  chatMessages.appendChild(item);
  chatMessages.scrollTop = chatMessages.scrollHeight; // Auto scroll
}

async function toggleMic() {
  const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
  if (!micBtn) return;

  if (isMicActive) {
    // マイクOFF
    stopLocalStream();
    isMicActive = false;
    micBtn.textContent = '🎤 マイク: OFF';
    micBtn.style.background = 'rgba(255, 108, 142, 0.1)';
    micBtn.style.color = '#ff6c8e';
    micBtn.style.borderColor = 'rgba(255, 108, 142, 0.25)';
    appendChatMessage('システム', '🎤 マイクをミュートしました。', true);
  } else {
    // マイクON
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      isMicActive = true;
      micBtn.textContent = '🎤 マイク: ON';
      micBtn.style.background = 'rgba(108, 255, 180, 0.15)';
      micBtn.style.color = '#6cffb4';
      micBtn.style.borderColor = 'rgba(108, 255, 180, 0.3)';
      appendChatMessage('システム', '🎤 マイクの使用を開始しました。', true);

      // すでにルームにいるメンバーとの接続にトラックを追加
      remotePlayers.forEach((_, targetId) => {
        let pci = peerConnections.get(targetId);
        if (!pci) {
          initiateWebRTCPeer(targetId);
          pci = peerConnections.get(targetId)!;
        }
        
        // 既存のセンダーがないかチェックしてトラック追加
        const currentTracks = pci.pc.getSenders().map(s => s.track);
        localStream!.getTracks().forEach((track) => {
          if (!currentTracks.includes(track)) {
            pci!.pc.addTrack(track, localStream!);
          }
        });

        // Offerを投げる
        sendWebRTCOffer(targetId);
      });

    } catch (err) {
      console.error('[WebRTC] マイク取得エラー:', err);
      appendChatMessage('システム', '⚠️ マイクの取得に失敗しました。パーミッションを確認してください。', true);
    }
  }
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  // 全PeerConnectionからトラックを取り除く
  peerConnections.forEach((pci) => {
    pci.pc.getSenders().forEach((sender) => {
      pci.pc.removeTrack(sender);
    });
  });
}

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19002' },
    { urls: 'stun:stun1.l.google.com:19002' },
    { urls: 'stun:stun2.l.google.com:19002' }
  ],
};

function initiateWebRTCPeer(targetId: string) {
  if (peerConnections.has(targetId)) return peerConnections.get(targetId)!.pc;

  const pc = new RTCPeerConnection(rtcConfig);
  const pci: PeerConnectionInfo = { pc };
  peerConnections.set(targetId, pci);

  // ローカルマイクがONならトラックを登録
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream!));
  }

  // ICE Candidateの送信
  pc.onicecandidate = (event) => {
    if (event.candidate && socket && socket.connected) {
      socket.emit('webrtc-candidate', { to: targetId, candidate: event.candidate });
    }
  };

  // 相手の音声トラックの受信
  pc.ontrack = (event) => {
    console.log(`[WebRTC] Received remote audio track from ${targetId}`);
    if (!pci.audio) {
      const audio = document.createElement('audio');
      audio.srcObject = event.streams[0];
      audio.autoplay = true;
      audio.style.display = 'none';
      document.body.appendChild(audio);
      pci.audio = audio;
    }
  };

  return pc;
}

async function sendWebRTCOffer(targetId: string) {
  const pci = peerConnections.get(targetId);
  if (!pci) return;

  try {
    const offer = await pci.pc.createOffer();
    await pci.pc.setLocalDescription(offer);
    if (socket && socket.connected) {
      socket.emit('webrtc-offer', { to: targetId, offer });
    }
  } catch (err) {
    console.error('[WebRTC] Offer作成エラー:', err);
  }
}

function closePeerConnection(targetId: string) {
  const pci = peerConnections.get(targetId);
  if (pci) {
    pci.pc.close();
    if (pci.audio) {
      pci.audio.pause();
      pci.audio.remove();
    }
    peerConnections.delete(targetId);
    console.log(`[WebRTC] Closed connection with ${targetId}`);
  }
}



