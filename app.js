// ─── Service Worker ───
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ─── PWA Install ───
let deferredPrompt;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('install-btn').style.display = 'flex';
});
document.getElementById('install-btn').addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') document.getElementById('install-btn').style.display = 'none';
        deferredPrompt = null;
    } else {
        openModal('ios-install-modal');
    }
});

// ─── Helpers ───
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsArrayBuffer(file);
    });
}

function showLoader(text = 'Processing...') {
    document.getElementById('loader-text').innerText = text;
    document.getElementById('loader-overlay').classList.add('visible');
}

function hideLoader() {
    document.getElementById('loader-overlay').classList.remove('visible');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

let _toastTimer;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── Navigation ───
let isDirty = false;
let currentScreen = 'home';

function attemptNavHome() {
    if (isDirty) openModal('unsaved-modal');
    else navTo('home');
}

function confirmNavHome() {
    closeModal('unsaved-modal');
    isDirty = false;
    navTo('home');
}

function navTo(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId + '-screen').classList.add('active');
    currentScreen = screenId;

    const header = document.getElementById('tool-header');
    const title = document.getElementById('tool-title');
    const actions = document.getElementById('header-actions');

    if (screenId === 'home') {
        header.classList.remove('visible');
        return;
    }

    header.classList.add('visible');

    if (screenId === 'editor') {
        title.innerText = 'Edit PDF';
        actions.innerHTML = `
            <button onclick="document.getElementById('upload-pdf').click()" class="btn btn-ghost">📂 Open</button>
            <div class="page-nav">
                <button onclick="changePage(-1)" id="prev-btn" disabled>◀</button>
                <span id="page-info">0/0</span>
                <button onclick="changePage(1)" id="next-btn" disabled>▶</button>
            </div>
            <button onclick="openExportModal()" class="btn btn-success">💾 Save</button>
        `;
    } else if (screenId === 'organize') {
        title.innerText = 'Organize Pages';
        actions.innerHTML = `<button onclick="openSaveModal('organize')" class="btn btn-success">💾 Save</button>`;
    } else if (screenId === 'merge') {
        title.innerText = 'Merge PDFs';
        actions.innerHTML = `
            <button onclick="document.getElementById('upload-merge').click()" class="btn btn-ghost">＋ Add PDF</button>
            <button onclick="openSaveModal('merge')" class="btn btn-success">🔗 Merge</button>
        `;
    } else if (screenId === 'split') {
        title.innerText = 'Extract Pages';
        actions.innerHTML = `
            <button onclick="selectAllSplitPages()" class="btn btn-ghost">☑ All</button>
            <button onclick="openSaveModal('split')" class="btn btn-success">✂️ Extract</button>
        `;
    }
}

let currentSaveAction = '';
function openSaveModal(action) {
    currentSaveAction = action;
    const defaults = { merge: 'Merged_Document', split: 'Extracted_Pages', organize: 'Organized_Document' };
    document.getElementById('save-filename').value = defaults[action] || 'Document';
    openModal('save-modal');
    document.getElementById('save-confirm-btn').onclick = () => {
        closeModal('save-modal');
        const name = document.getElementById('save-filename').value || defaults[action];
        if (action === 'organize') exportOrganizedPDF(name);
        else if (action === 'merge') exportMergedPDF(name);
        else if (action === 'split') exportSplitPDF(name);
    };
}

// ══════════════════════════════════════════
// MODULE 1: PDF EDITOR
// ══════════════════════════════════════════
const { jsPDF } = window.jspdf;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let canvas = new fabric.Canvas('main-canvas', {
    preserveObjectStacking: true,
    selection: true
});

let sigCanvas, pdfDoc = null, pageNum = 1, currentZoom = 1;
let pageStates = {}, activeTool = 'pan';
let undoStack = [], redoStack = [];

// ─── Undo system ───
function pushUndo() {
    undoStack.push(JSON.stringify(canvas));
    if (undoStack.length > 30) undoStack.shift();
    redoStack = [];
}

function undo() {
    if (!undoStack.length) { showToast('Nothing to undo'); return; }
    redoStack.push(JSON.stringify(canvas));
    const state = undoStack.pop();
    canvas.loadFromJSON(state, () => canvas.renderAll());
    isDirty = true;
}

canvas.on('object:added',   () => { isDirty = true; pushUndo(); });
canvas.on('object:modified',() => { isDirty = true; pushUndo(); });
canvas.on('object:removed', () => { isDirty = true; pushUndo(); });
canvas.on('path:created', function(opt) {
    isDirty = true;
    if (activeTool === 'highlighter') {
        opt.path.globalCompositeOperation = 'multiply';
        canvas.renderAll();
    }
});

// ─── Tool management ───
function setTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('tool-' + tool);
    if (btn) btn.classList.add('active');

    canvas.isDrawingMode = (tool === 'pen' || tool === 'highlighter');
    canvas.selection = (tool === 'pan');
    canvas.defaultCursor = tool === 'pan' ? 'grab' : tool === 'text' ? 'text' : 'crosshair';
    updateStyle();
}

// ─── Pinch-to-zoom ───
let initialPinchDistance = null;
const workspace = document.getElementById('workspace');
workspace.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2)
        initialPinchDistance = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
});
workspace.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDistance) {
        e.preventDefault();
        const d = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
        setZoom(d > initialPinchDistance ? 0.04 : -0.04);
        initialPinchDistance = d;
    }
}, { passive: false });
workspace.addEventListener('touchend', () => initialPinchDistance = null);

// ─── Canvas events ───
let isDragging = false, lastPosX, lastPosY;

canvas.on('mouse:down', function(opt) {
    if (activeTool === 'pan') {
        if (!opt.e.touches || opt.e.touches.length === 1) {
            isDragging = true;
            canvas.defaultCursor = 'grabbing';
            lastPosX = opt.e.clientX ?? opt.e.touches?.[0].clientX;
            lastPosY = opt.e.clientY ?? opt.e.touches?.[0].clientY;
        }
    } else if (activeTool === 'text') {
        if (opt.target?.type === 'i-text') return;
        const ptr = canvas.getPointer(opt.e);
        const obj = new fabric.IText('Type here...', {
            left: ptr.x, top: ptr.y,
            fill: document.getElementById('colorPicker').value,
            fontSize: parseInt(document.getElementById('sizePicker').value) || 20,
            fontFamily: document.getElementById('fontFamily').value,
        });
        canvas.add(obj);
        canvas.setActiveObject(obj);
        obj.enterEditing();
        obj.selectAll();
        setTool('pan');
    } else if (activeTool === 'shape') {
        const ptr = canvas.getPointer(opt.e);
        const rect = new fabric.Rect({
            left: ptr.x - 60, top: ptr.y - 40,
            width: 120, height: 80,
            fill: 'transparent',
            stroke: document.getElementById('colorPicker').value,
            strokeWidth: parseInt(document.getElementById('sizePicker').value) / 5 || 2,
            rx: 4, ry: 4,
        });
        canvas.add(rect);
        canvas.setActiveObject(rect);
        setTool('pan');
    }
});

canvas.on('mouse:move', function(opt) {
    if (isDragging && activeTool === 'pan') {
        const e = opt.e;
        const cx = e.clientX ?? e.touches?.[0].clientX;
        const cy = e.clientY ?? e.touches?.[0].clientY;
        if (cx !== undefined) {
            workspace.scrollLeft -= (cx - lastPosX);
            workspace.scrollTop  -= (cy - lastPosY);
            lastPosX = cx; lastPosY = cy;
        }
    }
});

canvas.on('mouse:up', () => { isDragging = false; if (activeTool === 'pan') canvas.defaultCursor = 'grab'; });
canvas.on('selection:created', syncToolbar);
canvas.on('selection:updated', syncToolbar);
canvas.on('text:editing:entered', syncToolbar);

function syncToolbar() {
    const active = canvas.getActiveObject();
    if (active?.type === 'i-text') {
        document.getElementById('colorPicker').value = active.fill || '#000000';
        document.getElementById('sizePicker').value = active.fontSize || 20;
        document.getElementById('fontFamily').value = active.fontFamily || 'Arial';
    }
}

// ─── Load PDF ───
document.getElementById('upload-pdf').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
        showLoader('Loading PDF...');
        const ab = await readFileAsArrayBuffer(file);
        pdfDoc = await pdfjsLib.getDocument(new Uint8Array(ab)).promise;
        pageNum = 1; pageStates = {}; isDirty = false; undoStack = [];
        document.getElementById('editor-placeholder').style.display = 'none';
        document.getElementById('canvas-wrapper').style.display = 'block';
        await renderPage(pageNum, true);
        showToast('PDF loaded — ' + pdfDoc.numPages + ' page' + (pdfDoc.numPages > 1 ? 's' : ''));
    } catch (err) {
        console.error(err);
        showToast('❌ Failed to load PDF');
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

async function renderPage(num, autoFit = false) {
    const page = await pdfDoc.getPage(num);
    const baseVP = page.getViewport({ scale: 1.5 });

    if (autoFit) {
        const avail = document.getElementById('workspace').clientWidth - 48;
        currentZoom = Math.min(avail / baseVP.width, 1.0);
    }

    const tmp = document.createElement('canvas');
    tmp.width = baseVP.width; tmp.height = baseVP.height;
    await page.render({ canvasContext: tmp.getContext('2d'), viewport: baseVP }).promise;

    canvas.clear();
    canvas.setDimensions({ width: baseVP.width, height: baseVP.height });
    const img = new fabric.Image(tmp);
    canvas.setBackgroundImage(img, () => {
        canvas.renderAll();
        if (pageStates[num]) canvas.loadFromJSON(pageStates[num], canvas.renderAll.bind(canvas));
        updateZoomDisplay();
    });

    document.getElementById('page-info').textContent = `${num}/${pdfDoc.numPages}`;
    document.getElementById('prev-btn').disabled = num <= 1;
    document.getElementById('next-btn').disabled = num >= pdfDoc.numPages;
}

function changePage(offset) {
    if (!pdfDoc) return;
    const np = pageNum + offset;
    if (np > 0 && np <= pdfDoc.numPages) {
        pageStates[pageNum] = JSON.stringify(canvas);
        pageNum = np;
        renderPage(pageNum);
    }
}

function updateZoomDisplay() {
    const wrapper = document.getElementById('canvas-wrapper');
    const spacer  = document.getElementById('scroll-spacer');
    wrapper.style.transform = `scale(${currentZoom})`;
    if (canvas) {
        spacer.style.width  = `${canvas.width  * currentZoom}px`;
        spacer.style.height = `${canvas.height * currentZoom}px`;
    }
    canvas.calcOffset();
}

function setZoom(delta) {
    currentZoom = Math.max(0.15, Math.min(4, currentZoom + delta));
    updateZoomDisplay();
}

function resetZoom() {
    if (!pdfDoc) return;
    const avail = workspace.clientWidth - 48;
    if (canvas.width) currentZoom = Math.min(avail / canvas.width, 1.0);
    updateZoomDisplay();
}

function updateStyle() {
    const color = document.getElementById('colorPicker').value;
    const size  = parseInt(document.getElementById('sizePicker').value) || 20;
    const font  = document.getElementById('fontFamily').value;
    const active = canvas.getActiveObject();

    if (active?.type === 'i-text') {
        active.set({ fill: color, fontSize: size, fontFamily: font });
        canvas.renderAll();
        isDirty = true;
    }

    if (activeTool === 'highlighter') {
        const r = parseInt(color.substr(1,2),16), g = parseInt(color.substr(3,2),16), b = parseInt(color.substr(5,2),16);
        canvas.freeDrawingBrush.color = `rgba(${r},${g},${b},0.35)`;
        canvas.freeDrawingBrush.width = size * 1.8;
    } else {
        canvas.freeDrawingBrush.color = color;
        canvas.freeDrawingBrush.width = size / 4;
    }
}

function deleteSelected() {
    const objs = canvas.getActiveObjects();
    if (!objs.length) { showToast('Nothing selected'); return; }
    canvas.discardActiveObject();
    objs.forEach(o => canvas.remove(o));
    isDirty = true;
    showToast(`Deleted ${objs.length} object${objs.length > 1 ? 's' : ''}`);
}

function duplicateSelected() {
    const active = canvas.getActiveObject();
    if (!active) { showToast('Nothing selected'); return; }
    active.clone(cloned => {
        cloned.set({ left: active.left + 20, top: active.top + 20 });
        canvas.add(cloned);
        canvas.setActiveObject(cloned);
        isDirty = true;
    });
}

// ─── Image upload ───
function handleImageUpload(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = f => {
        fabric.Image.fromURL(f.target.result, img => {
            img.scaleToWidth(Math.min(200, canvas.width * 0.4));
            img.set({ left: canvas.width/2, top: canvas.height/2, originX: 'center', originY: 'center' });
            canvas.add(img); canvas.setActiveObject(img);
            setTool('pan'); isDirty = true;
        });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

// ─── Signature ───
function openSignatureModal() {
    openModal('sig-modal');
    if (!sigCanvas) {
        sigCanvas = new fabric.Canvas('sig-canvas', { isDrawingMode: true });
        sigCanvas.freeDrawingBrush.width = 3;
        sigCanvas.freeDrawingBrush.color = '#000000';
    }
    sigCanvas.clear();
}

function clearSignature() { if (sigCanvas) sigCanvas.clear(); }

function saveSignature() {
    if (!sigCanvas || !sigCanvas.getObjects().length) { closeModal('sig-modal'); return; }
    fabric.Image.fromURL(sigCanvas.toDataURL('image/png'), img => {
        img.scaleToWidth(Math.min(180, canvas.width * 0.35));
        img.set({ left: canvas.width/2, top: canvas.height * 0.75, originX: 'center', originY: 'center' });
        canvas.add(img); canvas.setActiveObject(img);
        setTool('pan'); isDirty = true;
        closeModal('sig-modal');
        showToast('Signature added ✓');
    });
}

// ─── Stamps ───
const STAMPS = [
    { label: 'APPROVED', bg: '#16a34a', color: 'white' },
    { label: 'REJECTED', bg: '#dc2626', color: 'white' },
    { label: 'DRAFT',    bg: '#ca8a04', color: 'white' },
    { label: 'CONFIDENTIAL', bg: '#7c3aed', color: 'white' },
    { label: 'REVIEWED', bg: '#0284c7', color: 'white' },
    { label: 'SIGNED',   bg: '#0f766e', color: 'white' },
];

function insertStamp() {
    if (!pdfDoc) { showToast('Open a PDF first'); return; }
    const grid = document.getElementById('stamp-grid');
    grid.innerHTML = '';
    STAMPS.forEach(s => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            background:${s.bg}22;border:2px solid ${s.bg}66;color:${s.bg};
            border-radius:10px;padding:12px 8px;font-weight:700;font-size:12px;
            letter-spacing:1px;cursor:pointer;font-family:var(--font-display);
            transition:all 0.2s;
        `;
        btn.textContent = s.label;
        btn.onmouseenter = () => btn.style.background = s.bg + '33';
        btn.onmouseleave = () => btn.style.background = s.bg + '22';
        btn.onclick = () => {
            const text = new fabric.Text(s.label, {
                left: canvas.width/2, top: canvas.height/2,
                originX: 'center', originY: 'center',
                fill: s.bg,
                fontSize: 36,
                fontFamily: 'Impact',
                fontWeight: 'bold',
                opacity: 0.8,
                stroke: s.bg,
                strokeWidth: 1,
                angle: -15,
            });
            canvas.add(text);
            canvas.setActiveObject(text);
            setTool('pan');
            isDirty = true;
            closeModal('stamp-modal');
            showToast(`${s.label} stamp added`);
        };
        grid.appendChild(btn);
    });
    openModal('stamp-modal');
}

// ─── Export ───
function openExportModal() {
    if (!pdfDoc) { showToast('Open a PDF first'); return; }
    openModal('export-modal');
}

async function executeExport() {
    closeModal('export-modal');
    showLoader('Exporting...');
    const name   = document.getElementById('export-name').value || 'Edited_Document';
    const format = document.getElementById('export-format').value;

    await new Promise(r => setTimeout(r, 50));

    if (format === 'png') {
        const a = document.createElement('a');
        a.href = canvas.toDataURL({ format: 'png', quality: 1 });
        a.download = name + '.png';
        a.click();
        showToast('Page exported as PNG ✓');
    } else {
        pageStates[pageNum] = JSON.stringify(canvas);
        let pdf = null;

        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i);
            const vp = page.getViewport({ scale: 2 });
            const tmp = document.createElement('canvas');
            tmp.width = vp.width; tmp.height = vp.height;
            await page.render({ canvasContext: tmp.getContext('2d'), viewport: vp }).promise;

            const sc = new fabric.StaticCanvas(null, { width: vp.width, height: vp.height });
            await new Promise(res => {
                const bg = new fabric.Image(tmp);
                sc.setBackgroundImage(bg, () => {
                    if (pageStates[i]) sc.loadFromJSON(pageStates[i], () => { sc.renderAll(); res(); });
                    else res();
                });
            });

            const imgData = sc.toDataURL('image/jpeg', 0.85);
            const orient = vp.width > vp.height ? 'l' : 'p';
            if (i === 1) pdf = new jsPDF({ orientation: orient, unit: 'px', format: [vp.width, vp.height] });
            else pdf.addPage([vp.width, vp.height], orient);
            pdf.addImage(imgData, 'JPEG', 0, 0, vp.width, vp.height);
        }

        const blob = pdf.output('blob');
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = name + '.pdf';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('PDF saved ✓');
    }

    isDirty = false;
    hideLoader();
}

// keyboard shortcuts
document.addEventListener('keydown', e => {
    if (currentScreen !== 'editor') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!canvas.getActiveObject()?.isEditing) { e.preventDefault(); deleteSelected(); }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); duplicateSelected(); }
    if (e.key === 'ArrowLeft') changePage(-1);
    if (e.key === 'ArrowRight') changePage(1);
});

// ══════════════════════════════════════════
// MODULE 2: ORGANIZE
// ══════════════════════════════════════════
let orgPdfDoc = null, orgPdfJsDoc = null, orgPageArray = [];

document.getElementById('upload-org').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
        showLoader('Loading pages...');
        document.getElementById('org-upload-box').style.display = 'none';
        isDirty = false;
        const ab = await readFileAsArrayBuffer(file);
        orgPdfDoc   = await PDFLib.PDFDocument.load(ab);
        orgPdfJsDoc = await pdfjsLib.getDocument(new Uint8Array(ab)).promise;
        orgPageArray = Array.from({ length: orgPdfJsDoc.numPages }, (_, i) => i);
        await renderOrganizeGrid();
        showToast(orgPdfJsDoc.numPages + ' pages loaded');
    } catch (err) {
        console.error(err);
        showToast('❌ Failed to read PDF');
        document.getElementById('org-upload-box').style.display = '';
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

async function renderOrganizeGrid() {
    const grid = document.getElementById('thumbnail-grid');
    grid.innerHTML = '';
    for (let i = 0; i < orgPageArray.length; i++) {
        const page = await orgPdfJsDoc.getPage(orgPageArray[i] + 1);
        const vp   = page.getViewport({ scale: 0.3 });
        const fullVP = page.getViewport({ scale: 1.2 });

        const wrap = document.createElement('div');
        wrap.className = 'thumb-card';

        // Badge
        const badge = document.createElement('div');
        badge.className = 'thumb-badge';
        badge.textContent = i + 1;
        wrap.appendChild(badge);

        // Thumbnail canvas
        const tc = document.createElement('canvas');
        tc.width = vp.width; tc.height = vp.height;
        tc.style.borderRadius = '6px';
        await page.render({ canvasContext: tc.getContext('2d'), viewport: vp }).promise;
        wrap.appendChild(tc);

        // Preview popup
        const preview = document.createElement('div');
        preview.className = 'preview-popup';
        const pc = document.createElement('canvas');
        pc.width = fullVP.width; pc.height = fullVP.height;
        pc.style.maxWidth = '75vw'; pc.style.maxHeight = '65vh'; pc.style.objectFit = 'contain';
        page.render({ canvasContext: pc.getContext('2d'), viewport: fullVP });
        preview.appendChild(pc);
        wrap.appendChild(preview);

        // Controls
        const controls = document.createElement('div');
        controls.className = 'thumb-controls';
        controls.innerHTML = `
            <button class="thumb-ctrl-btn" onclick="movePage(${i},-1)" title="Move left">◀</button>
            <button class="thumb-ctrl-btn del" onclick="deletePage(${i})" title="Delete page">✕</button>
            <button class="thumb-ctrl-btn" onclick="movePage(${i},1)" title="Move right">▶</button>
        `;
        wrap.appendChild(controls);
        grid.appendChild(wrap);
    }
}

function movePage(index, dir) {
    const ni = index + dir;
    if (ni < 0 || ni >= orgPageArray.length) return;
    [orgPageArray[index], orgPageArray[ni]] = [orgPageArray[ni], orgPageArray[index]];
    isDirty = true;
    renderOrganizeGrid();
}

function deletePage(index) {
    orgPageArray.splice(index, 1);
    isDirty = true;
    if (!orgPageArray.length) {
        document.getElementById('org-upload-box').style.display = '';
        document.getElementById('thumbnail-grid').innerHTML = '';
        orgPdfDoc = null;
        showToast('All pages deleted');
    } else {
        renderOrganizeGrid();
        showToast('Page deleted');
    }
}

async function exportOrganizedPDF(filename) {
    if (!orgPdfDoc || !orgPageArray.length) return;
    showLoader('Saving...');
    try {
        const newPdf = await PDFLib.PDFDocument.create();
        const pages  = await newPdf.copyPages(orgPdfDoc, orgPageArray);
        pages.forEach(p => newPdf.addPage(p));
        triggerDownload(await newPdf.save(), filename + '.pdf');
        isDirty = false;
        showToast('PDF saved ✓');
    } catch (e) { console.error(e); showToast('❌ Export failed'); }
    hideLoader();
}

// ══════════════════════════════════════════
// MODULE 3: MERGE
// ══════════════════════════════════════════
let mergeFiles = [];

document.getElementById('upload-merge').addEventListener('change', e => {
    mergeFiles = mergeFiles.concat(Array.from(e.target.files));
    isDirty = true;
    e.target.value = '';
    renderMergeList();
    showToast(mergeFiles.length + ' file' + (mergeFiles.length !== 1 ? 's' : '') + ' queued');
});

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderMergeList() {
    const list = document.getElementById('merge-list');
    list.innerHTML = '';
    if (!mergeFiles.length) return;

    mergeFiles.forEach((file, i) => {
        const item = document.createElement('div');
        item.className = 'merge-item';
        item.innerHTML = `
            <div class="merge-item-name">
                <div class="merge-item-icon">📄</div>
                <div class="merge-item-text">
                    <div class="fname">${file.name}</div>
                    <div class="fsize">${formatBytes(file.size)}</div>
                </div>
            </div>
            <div class="merge-controls">
                <button class="btn btn-ghost" onclick="moveMergeFile(${i},-1)" style="padding:5px 8px">🔼</button>
                <button class="btn btn-ghost" onclick="moveMergeFile(${i},1)" style="padding:5px 8px">🔽</button>
                <button class="btn btn-danger" onclick="removeMergeFile(${i})" style="padding:5px 10px">✕</button>
            </div>
        `;
        list.appendChild(item);
    });
}

function moveMergeFile(i, dir) {
    const ni = i + dir;
    if (ni < 0 || ni >= mergeFiles.length) return;
    [mergeFiles[i], mergeFiles[ni]] = [mergeFiles[ni], mergeFiles[i]];
    isDirty = true;
    renderMergeList();
}

function removeMergeFile(i) {
    mergeFiles.splice(i, 1);
    isDirty = true;
    renderMergeList();
    showToast('File removed');
}

async function exportMergedPDF(filename) {
    if (mergeFiles.length < 2) { showToast('Add at least 2 PDFs to merge'); return; }
    showLoader('Merging PDFs...');
    try {
        const merged = await PDFLib.PDFDocument.create();
        for (const file of mergeFiles) {
            const ab  = await readFileAsArrayBuffer(file);
            const pdf = await PDFLib.PDFDocument.load(ab);
            const pgs = await merged.copyPages(pdf, pdf.getPageIndices());
            pgs.forEach(p => merged.addPage(p));
        }
        triggerDownload(await merged.save(), filename + '.pdf');
        isDirty = false;
        showToast('Merged PDF saved ✓');
    } catch (e) { console.error(e); showToast('❌ Merge failed'); }
    hideLoader();
}

// ══════════════════════════════════════════
// MODULE 4: SPLIT / EXTRACT
// ══════════════════════════════════════════
let splitSelectedPages = new Set();

document.getElementById('upload-split').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
        showLoader('Loading pages...');
        document.getElementById('split-upload-box').style.display = 'none';
        isDirty = false;

        const ab = await readFileAsArrayBuffer(file);
        orgPdfDoc   = await PDFLib.PDFDocument.load(ab);
        orgPdfJsDoc = await pdfjsLib.getDocument(new Uint8Array(ab)).promise;
        splitSelectedPages.clear();

        const grid = document.getElementById('split-grid');
        grid.innerHTML = '';

        for (let i = 0; i < orgPdfJsDoc.numPages; i++) {
            const page = await orgPdfJsDoc.getPage(i + 1);
            const vp   = page.getViewport({ scale: 0.3 });
            const fullVP = page.getViewport({ scale: 1.2 });

            const wrap = document.createElement('div');
            wrap.className = 'thumb-card';
            wrap.title = 'Click to select page ' + (i + 1);

            const badge = document.createElement('div');
            badge.className = 'thumb-badge';
            badge.id = `split-badge-${i}`;
            badge.textContent = i + 1;
            wrap.appendChild(badge);

            const tc = document.createElement('canvas');
            tc.width = vp.width; tc.height = vp.height;
            tc.style.borderRadius = '6px';
            await page.render({ canvasContext: tc.getContext('2d'), viewport: vp }).promise;
            wrap.appendChild(tc);

            const preview = document.createElement('div');
            preview.className = 'preview-popup';
            const pc = document.createElement('canvas');
            pc.width = fullVP.width; pc.height = fullVP.height;
            pc.style.maxWidth = '75vw'; pc.style.maxHeight = '65vh';
            page.render({ canvasContext: pc.getContext('2d'), viewport: fullVP });
            preview.appendChild(pc);
            wrap.appendChild(preview);

            wrap.onclick = () => {
                isDirty = true;
                if (splitSelectedPages.has(i)) {
                    splitSelectedPages.delete(i);
                    wrap.classList.remove('selected');
                } else {
                    splitSelectedPages.add(i);
                    wrap.classList.add('selected');
                }
                updateSplitCount();
            };

            grid.appendChild(wrap);
        }
        showToast(orgPdfJsDoc.numPages + ' pages loaded — tap to select');
    } catch (err) {
        console.error(err);
        showToast('❌ Failed to load PDF');
        document.getElementById('split-upload-box').style.display = '';
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

function updateSplitCount() {
    const n = splitSelectedPages.size;
    // Update extract button text dynamically
    const btn = document.querySelector('#header-actions .btn-success');
    if (btn) btn.textContent = n > 0 ? `✂️ Extract (${n})` : '✂️ Extract';
}

function selectAllSplitPages() {
    const grid = document.getElementById('split-grid');
    const cards = grid.querySelectorAll('.thumb-card');
    const allSelected = splitSelectedPages.size === cards.length;

    splitSelectedPages.clear();
    cards.forEach((card, i) => {
        if (!allSelected) {
            splitSelectedPages.add(i);
            card.classList.add('selected');
        } else {
            card.classList.remove('selected');
        }
    });
    updateSplitCount();
    showToast(allSelected ? 'All deselected' : `All ${cards.length} pages selected`);
}

async function exportSplitPDF(filename) {
    if (!orgPdfDoc || !splitSelectedPages.size) { showToast('Select at least one page'); return; }
    showLoader('Extracting...');
    try {
        const newPdf = await PDFLib.PDFDocument.create();
        const sorted = [...splitSelectedPages].sort((a, b) => a - b);
        const pages  = await newPdf.copyPages(orgPdfDoc, sorted);
        pages.forEach(p => newPdf.addPage(p));
        triggerDownload(await newPdf.save(), filename + '.pdf');
        isDirty = false;
        showToast(`${sorted.length} page${sorted.length > 1 ? 's' : ''} extracted ✓`);
    } catch (e) { console.error(e); showToast('❌ Extract failed'); }
    hideLoader();
}

// ─── Utils ───
function triggerDownload(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Expose all functions to global scope ───
// Required because the script loads with `defer` — inline onclick=""
// handlers need window-level access to these functions.
window.navTo              = navTo;
window.attemptNavHome     = attemptNavHome;
window.confirmNavHome     = confirmNavHome;
window.closeModal         = closeModal;
window.openModal          = openModal;
window.openSaveModal      = openSaveModal;
window.openExportModal    = openExportModal;
window.executeExport      = executeExport;
window.setTool            = setTool;
window.setZoom            = setZoom;
window.resetZoom          = resetZoom;
window.changePage         = changePage;
window.deleteSelected     = deleteSelected;
window.duplicateSelected  = duplicateSelected;
window.insertStamp        = insertStamp;
window.openSignatureModal = openSignatureModal;
window.clearSignature     = clearSignature;
window.saveSignature      = saveSignature;
window.handleImageUpload  = handleImageUpload;
window.movePage           = movePage;
window.deletePage         = deletePage;
window.moveMergeFile      = moveMergeFile;
window.removeMergeFile    = removeMergeFile;
window.selectAllSplitPages= selectAllSplitPages;
window.undo               = undo;