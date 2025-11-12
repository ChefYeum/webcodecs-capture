const TARGET_LENGTH = 20;
const BASE_CONFIG = { togglePeriodMs: 500 } as const;

type AppState = {
    phaseIsWhite: boolean;
    status: string;
    error: string;
    pendingCaptures: number;
    captures: string[];
    captureComplete: boolean;
    patternString: string;
    isRunning: boolean;
    selectedCaptureIndex: number | null;
};

type AppEvent =
    | { type: 'pattern-changed'; value: string }
    | { type: 'begin-run'; patternString: string }
    | { type: 'phase-changed'; isWhite: boolean }
    | { type: 'frame-captured'; dataUrl: string }
    | { type: 'stream-started' }
    | { type: 'error'; message: string; status?: string }
    | { type: 'run-complete' }
    | { type: 'select-capture'; index: number };

type ParsedPattern = {
    text: string;
    sequence: boolean[];
    isComplete: boolean;
};

const DARK_FRAME_THEME = {
    '--bg-color': '#05060c',
    '--text-color': '#f5f5f5',
    '--panel': 'rgba(12, 16, 28, 0.7)',
    '--panel-border': 'rgba(255, 255, 255, 0.15)'
} as const;

const LIGHT_FRAME_THEME = {
    '--bg-color': '#f5f5f5',
    '--text-color': '#05060c',
    '--panel': 'rgba(255, 255, 255, 0.78)',
    '--panel-border': 'rgba(0, 0, 0, 0.12)'
} as const;

function parsePatternInput(value: string, limit = TARGET_LENGTH): ParsedPattern {
    const text = value
        .toUpperCase()
        .replace(/[^BW]/g, '')
        .slice(0, limit);
    const sequence = Array.from(text, char => char === 'W');
    return {
        text,
        sequence,
        isComplete: sequence.length === limit
    };
}

// Note: mirrored the single-run cleanup effect React hooks provide when returning a teardown function.
function createOnce<T extends (...args: unknown[]) => void>(fn: T): (...args: Parameters<T>) => void {
    let called = false;
    return (...args: Parameters<T>) => {
        if (called) {
            return;
        }
        called = true;
        fn(...args);
    };
}

// Note: in React we'd tuck this interval into a useEffect hook and return the stop function automatically.
function startIllumination(pattern: boolean[], onPhase: (isWhite: boolean) => void): () => void {
    if (!pattern.length) {
        return createOnce(() => undefined);
    }
    let index = 0;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;

    const emitStep = () => {
        if (index >= pattern.length) {
            if (intervalId !== null) {
                clearInterval(intervalId);
                intervalId = null;
            }
            return;
        }
        const isWhite = pattern[index];
        onPhase(isWhite);
        index += 1;
        if (index >= pattern.length && intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
        }
    };

    intervalId = window.setInterval(emitStep, BASE_CONFIG.togglePeriodMs);
    emitStep();

    return createOnce(() => {
        if (intervalId !== null) {
            clearInterval(intervalId);
        }
    });
}

// Main
// Note: frameworks usually hand you refs through components; here we cache the DOM nodes manually.
const dom = {
    root: document.documentElement,
    canvas: document.getElementById('preview') as HTMLCanvasElement,
    controls: document.querySelector('.controls') as HTMLElement | null,
    galleryView: document.getElementById('gallery-view') as HTMLElement,
    error: document.getElementById('error') as HTMLElement,
    captureGrid: document.getElementById('capture-grid') as HTMLElement,
    selectedFrame: document.getElementById('selected-frame') as HTMLImageElement,
    patternInput: document.getElementById('pattern-input') as HTMLInputElement,
    startButton: document.getElementById('start-button') as HTMLButtonElement,
} as const;

const initialState: AppState = {
    phaseIsWhite: false,
    status: `Enter ${TARGET_LENGTH} frame pattern to begin.`,
    error: '',
    pendingCaptures: 0,
    captures: [],
    captureComplete: false,
    patternString: '',
    isRunning: false,
    selectedCaptureIndex: null
};

let state: AppState = initialState;

// Note: frameworks like React would let component re-renders reconcile these DOM updates
// (instead of us mutating each node manually)
function render(nextState: AppState): void {
    // Sync theme variables so the page tint follows the current illumination phase
    const theme = nextState.phaseIsWhite ? LIGHT_FRAME_THEME : DARK_FRAME_THEME;
    Object.entries(theme).forEach(([name, value]) => {
        dom.root.style.setProperty(name, value);
    });

    // Surface current error messaging to the user
    dom.error.textContent = nextState.error;

    // Flip between capture view and gallery view as soon as captures complete
    const galleryActive = nextState.captureComplete;
    document.body.classList.toggle('is-gallery', galleryActive);
    dom.galleryView.hidden = !galleryActive;
    if (dom.controls) {
        dom.controls.style.display = nextState.isRunning ? 'none' : '';
    }

    // Keep the pattern input mirrored to state, caret placed at the end
    if (dom.patternInput.value !== nextState.patternString) {
        dom.patternInput.value = nextState.patternString;
        const caret = nextState.patternString.length;
        dom.patternInput.setSelectionRange(caret, caret);
    }
    dom.patternInput.disabled = nextState.isRunning;
    dom.patternInput.maxLength = TARGET_LENGTH;
    dom.startButton.disabled = nextState.isRunning || nextState.patternString.length !== TARGET_LENGTH;
    if (nextState.isRunning) {
        dom.startButton.textContent = 'Running…';
    } else {
        dom.startButton.innerHTML = `Start Capture<br><span class="start-button-count">(${`${nextState.patternString.length}/${TARGET_LENGTH}`})</span>`;
    }

    // Regenerate the gallery grid whenever captured frames change
    const selectedIndex = nextState.selectedCaptureIndex;
    dom.captureGrid.innerHTML = nextState.captures
        .map((src, index) => {
            const selectedClass = index === selectedIndex ? ' selected' : '';
            return `<img src="${src}" alt="Captured frame ${index + 1}" data-index="${index}" class="capture-thumb${selectedClass}">`;
        })
        .join('');

    if (selectedIndex === null) {
        dom.selectedFrame.removeAttribute('src');
        dom.selectedFrame.alt = 'Selected capture preview';
        dom.selectedFrame.hidden = true;
    } else {
        dom.selectedFrame.src = nextState.captures[selectedIndex] ?? '';
        dom.selectedFrame.alt = `Captured frame ${selectedIndex + 1}`;
        dom.selectedFrame.hidden = false;
    }

    if (previewVideo) {
        previewVideo.hidden = nextState.isRunning;
        dom.canvas.hidden = !nextState.isRunning;
    } else {
        dom.canvas.hidden = false;
    }
}

function reduce(current: AppState, event: AppEvent): AppState {
    switch (event.type) {
        case 'pattern-changed': {
            const patternString = event.value;
            if (current.isRunning) {
                return {
                    ...current,
                    patternString
                };
            }
            const remaining = TARGET_LENGTH - patternString.length;
            const status = remaining > 0
                ? `Add ${remaining} more ${remaining === 1 ? 'character' : 'characters'} to begin.`
                : 'Pattern ready — press start to capture.';
            return {
                ...current,
                patternString,
                error: '',
                status
            };
        }
        case 'begin-run':
            return {
                ...current,
                phaseIsWhite: false,
                status: 'Preparing capture…',
                error: '',
                pendingCaptures: 0,
                captures: [],
                captureComplete: false,
                isRunning: true,
                patternString: event.patternString,
                selectedCaptureIndex: null
            };
        case 'phase-changed': {
            const remainingBudget = TARGET_LENGTH - current.captures.length;
            const pending = Math.max(0, Math.min(current.pendingCaptures + 1, remainingBudget));
            const status = current.captures.length >= TARGET_LENGTH
                ? 'Capture complete — review below.'
                : `Capturing… (${current.captures.length}/${TARGET_LENGTH})`;
            return {
                ...current,
                pendingCaptures: pending,
                phaseIsWhite: event.isWhite,
                status
            };
        }
        case 'frame-captured': {
            const captures = [...current.captures, event.dataUrl];
            const done = captures.length >= TARGET_LENGTH;
            const status = done
                ? 'Capture complete — review below.'
                : `Capturing… (${captures.length}/${TARGET_LENGTH})`;
            return {
                ...current,
                captures,
                pendingCaptures: Math.max(0, current.pendingCaptures - 1),
                status,
                captureComplete: done,
                selectedCaptureIndex: current.selectedCaptureIndex ?? 0
            };
        }
        case 'stream-started':
            return {
                ...current,
                status: 'Streaming…',
                error: ''
            };
        case 'error':
            return {
                ...current,
                error: event.message,
                status: event.status ?? 'Error',
                isRunning: false
            };
        case 'run-complete':
            return {
                ...current,
                isRunning: false,
                phaseIsWhite: false
            };
        case 'select-capture':
            return {
                ...current,
                selectedCaptureIndex: event.index
            };
        default:
            return current;
    }
}

function dispatch(event: AppEvent): AppState {
    state = reduce(state, event);
    render(state);
    return state;
}

function attachPreview(nextStream: MediaStream): void {
    if (!previewVideo) {
        previewVideo = document.createElement('video');
        previewVideo.muted = true;
        previewVideo.autoplay = true;
        previewVideo.playsInline = true;
        previewVideo.className = 'preview-video';
        previewVideo.width = dom.canvas.width;
        previewVideo.height = dom.canvas.height;
        const parent = dom.canvas.parentElement;
        if (parent) {
            parent.insertBefore(previewVideo, dom.canvas);
        } else {
            document.body.insertBefore(previewVideo, dom.canvas);
        }
    }

    previewVideo.srcObject = nextStream;
    previewVideo.hidden = state.isRunning;
    previewVideo.play().catch(() => undefined);

    // Re-render so the canvas/preview visibility stays in sync after attaching.
    render(state);
}

async function initCamera(): Promise<MediaStream | null> {
    if (stream) {
        return stream;
    }

    if (streamInit) {
        return streamInit;
    }

    streamInit = (async () => {
        const devices = navigator.mediaDevices;
        if (!devices?.getUserMedia) {
            dispatch({
                type: 'error',
                message: 'Webcam APIs unavailable in this browser.',
                status: 'Webcam unavailable'
            });
            return null;
        }

        try {
            const nextStream = await devices.getUserMedia({ video: true, audio: false });
            stream = nextStream;
            dispatch({ type: 'stream-started' });
            attachPreview(nextStream);
            return nextStream;
        } catch (error) {
            console.error('Camera access failed:', error);
            dispatch({
                type: 'error',
                message: 'Camera permission denied.',
                status: 'Permission required'
            });
            return null;
        } finally {
            streamInit = null;
        }
    })();

    return streamInit;
}

let stream: MediaStream | null = null;
let streamInit: Promise<MediaStream | null> | null = null;
let previewVideo: HTMLVideoElement | null = null;

async function run(pattern: boolean[]): Promise<void> {
    const activeStream = stream ?? await initCamera();
    if (!activeStream) {
        dispatch({ type: 'run-complete' });
        return;
    }

    const ctx = dom.canvas.getContext('2d')!;

    const [videoTrack] = activeStream.getVideoTracks();
    const Processor = window.MediaStreamTrackProcessor;
    if (!Processor) {
        dispatch({
            type: 'error',
            message: 'WebCodecs not supported in this browser.',
            status: 'WebCodecs unavailable'
        });
        dispatch({ type: 'run-complete' });
        return;
    }
    const processor = new Processor({ track: videoTrack });
    const reader = processor.readable.getReader();
    const stopIllumination = startIllumination(pattern, isWhite => {
        dispatch({ type: 'phase-changed', isWhite });
    });

    const cleanup = createOnce(() => {
        stopIllumination();
        reader.cancel().catch(() => undefined);
        window.removeEventListener('beforeunload', cleanup);
        dispatch({ type: 'run-complete' });
    });

    window.addEventListener('beforeunload', cleanup);

    try {
        while (true) {
            const { value: frame, done } = await reader.read();
            if (done || !frame) {
                break;
            }

            try {
                ctx.drawImage(frame, 0, 0, dom.canvas.width, dom.canvas.height);
                if (state.pendingCaptures > 0 && state.captures.length < TARGET_LENGTH) {
                    dispatch({
                        type: 'frame-captured',
                        dataUrl: dom.canvas.toDataURL('image/png')
                    });
                    if (state.captures.length >= TARGET_LENGTH) {
                        stopIllumination();
                    }
                }
            } finally {
                frame.close();
            }
        }
    } catch (error) {
        console.error('Rendering error:', error);
        dispatch({ type: 'error', message: 'Rendering stopped.' });
    } finally {
        cleanup();
    }
}

function startFromControls(): void {
    if (state.isRunning) {
        return;
    }
    const parsed = parsePatternInput(dom.patternInput.value ?? '');
    if (dom.patternInput.value !== parsed.text) {
        dom.patternInput.value = parsed.text;
    }
    if (!parsed.isComplete) {
        dispatch({
            type: 'error',
            message: `Enter exactly ${TARGET_LENGTH} characters using only B and W.`,
            status: 'Pattern incomplete'
        });
        dom.patternInput.focus();
        return;
    }

    if (parsed.text !== state.patternString) {
        dispatch({ type: 'pattern-changed', value: parsed.text });
    }

    dispatch({ type: 'begin-run', patternString: parsed.text });
    dom.patternInput.blur();
    run(parsed.sequence).catch((error: unknown) => {
        console.error('Unexpected error:', error);
        dispatch({ type: 'error', message: 'Capture aborted unexpectedly.' });
    });
}

dom.patternInput.addEventListener('input', event => {
    if (state.isRunning) {
        return;
    }
    const target = event.target as HTMLInputElement;
    const parsed = parsePatternInput(target.value);
    if (parsed.text !== target.value) {
        target.value = parsed.text;
    }
    if (parsed.text !== state.patternString) {
        dispatch({ type: 'pattern-changed', value: parsed.text });
    }
});

dom.patternInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        startFromControls();
    }
});

dom.startButton.addEventListener('click', startFromControls);

dom.captureGrid.addEventListener('click', event => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) {
        return;
    }
    const index = Number(target.dataset.index);
    if (!Number.isFinite(index) || index === state.selectedCaptureIndex) {
        return;
    }
    dispatch({ type: 'select-capture', index });
});

render(state);
initCamera().catch(error => {
    console.error('Camera init failed:', error);
});

