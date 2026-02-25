// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
}

// Helper: Safely load files across all browsers
function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

// --- App State & Navigation ---
let isDirty = false;

function attemptNavHome() {
    if (isDirty) document.getElementById('unsaved-modal').classList.remove('hidden');
    else navTo('home');
}

function confirmNavHome() {
    closeModal('unsaved-modal');
    isDirty = false;
    navTo('home');
}

function navTo(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId + '-screen').classList.remove('hidden');
    document.getElementById('tool-header').classList.remove('hidden');
    
    const title = document.getElementById('tool-title');
    const actions = document.getElementById('header-actions');
    
    if (screenId === 'home') {
        document.getElementById('tool-header').classList.add('hidden');
    } else if (screenId === 'editor') {
        title.innerText = 'Edit PDF';
        actions.innerHTML = `
            <button onclick="document.getElementById('upload-pdf').click()" class="bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg text-sm font-medium">📂 Open</button>
            <div class="flex items-center gap-2 bg-slate-900 px-2 py-1 rounded-lg">
                <button onclick="changePage(-1)" id="prev-btn" disabled class="disabled:opacity-30">◀</button>
                <span id="page-info" class="text-xs font-bold min-w-[30px] text-center">0/0</span>
                <button onclick="changePage(1)" id="next-btn" disabled class="disabled:opacity-30">▶</button>
            </div>
            <button onclick="openExportModal()" class="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-medium text-white">💾 Save</button>
        `;
        if (pdfDoc) updateZoomDisplay();
    } else if (screenId === 'organize') {
        title.innerText = 'Organize Pages';
        actions.innerHTML = `<button onclick="openSaveModal('organize')" class="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-medium text-white">💾 Save</button>`;
    } else if (screenId === 'merge') {
        title.innerText = 'Merge PDFs';
        actions.innerHTML = `<button onclick="document.getElementById('upload-merge').click()" class="bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg text-sm font-medium">➕ Add</button><button onclick="openSaveModal('merge')" class="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-medium text-white">💾 Merge</button>`;
    } else if (screenId === 'split') {
        title.innerText = 'Extract Pages';
        actions.innerHTML = `<button onclick="openSaveModal('split')" class="bg-green-600 hover:bg-green-500 px-3 py-1.5 rounded-lg text-sm font-medium text-white">💾 Extract</button>`;
    }
}

function showLoader(text) { document.getElementById('loader-overlay').classList.remove('hidden'); document.getElementById('loader-text').innerText=text; }
function hideLoader() { document.getElementById('loader-overlay').classList.add('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

let currentSaveAction = '';
function openSaveModal(action) {
    currentSaveAction = action;
    document.getElementById('save-filename').value = action === 'merge' ? 'Merged_Doc' : action === 'split' ? 'Extracted_Pages' : 'Organized_Doc';
    document.getElementById('save-modal').classList.remove('hidden');
    document.getElementById('save-confirm-btn').onclick = () => {
        closeModal('save-modal');
        const name = document.getElementById('save-filename').value;
        if(action === 'organize') exportOrganizedPDF(name);
        else if(action === 'merge') exportMergedPDF(name);
        else if(action === 'split') exportSplitPDF(name);
    };
}

// ==========================================
// MODULE 1: PDF EDITOR
// ==========================================
const { jsPDF } = window.jspdf;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

let canvas = new fabric.Canvas('main-canvas', { preserveObjectStacking: true, selection: false });
let sigCanvas, pdfDoc = null, pageNum = 1, currentZoom = 1;
let pageStates = {}, activeTool = 'pan';

canvas.on('object:added', () => isDirty = true);
canvas.on('object:modified', () => isDirty = true);
canvas.on('object:removed', () => isDirty = true);
canvas.on('path:created', function(opt) { 
    isDirty = true;
    if (activeTool === 'highlighter') { opt.path.globalCompositeOperation = 'multiply'; canvas.renderAll(); } 
});

function setTool(tool) {
    activeTool = tool;
    document.querySelectorAll('.ed-btn').forEach(b => b.classList.remove('active-tool'));
    document.getElementById('tool-' + tool)?.classList.add('active-tool');
    
    canvas.isDrawingMode = (tool === 'pen' || tool === 'highlighter');
    canvas.selection = (tool !== 'pan');
    canvas.defaultCursor = tool === 'pan' ? 'grab' : (tool === 'text' ? 'text' : 'default');
    updateStyle();
}

let initialPinchDistance = null;
const workspace = document.getElementById('workspace');
workspace.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) initialPinchDistance = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
});
workspace.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDistance) {
        e.preventDefault(); 
        let currentDistance = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
        let scaleChange = currentDistance / initialPinchDistance;
        setZoom(scaleChange > 1 ? 0.05 : -0.05); 
        initialPinchDistance = currentDistance; 
    }
}, { passive: false });
workspace.addEventListener('touchend', () => initialPinchDistance = null);

canvas.on('mouse:down', function(opt) {
    if (activeTool === 'pan' && !opt.e.touches || (opt.e.touches && opt.e.touches.length === 1)) {
        isDragging = true;
        canvas.defaultCursor = 'grabbing';
        lastPosX = opt.e.clientX || opt.e.touches?.[0].clientX;
        lastPosY = opt.e.clientY || opt.e.touches?.[0].clientY;
    } else if (activeTool === 'text' && !opt.target) {
        let pointer = canvas.getPointer(opt.e);
        let textObj = new fabric.IText('Type here...', {
            left: pointer.x, top: pointer.y,
            fill: document.getElementById('colorPicker').value,
            fontSize: parseInt(document.getElementById('sizePicker').value),
            fontFamily: document.getElementById('fontFamily').value || 'Arial'
        });
        canvas.add(textObj); canvas.setActiveObject(textObj);
        textObj.enterEditing(); textObj.selectAll();
        setTool('pan'); 
    }
});

let isDragging = false, lastPosX, lastPosY;
canvas.on('mouse:move', function(opt) {
    if (isDragging && activeTool === 'pan') {
        let e = opt.e;
        let clientX = e.clientX || e.touches?.[0].clientX;
        let clientY = e.clientY || e.touches?.[0].clientY;
        workspace.scrollLeft -= (clientX - lastPosX);
        workspace.scrollTop -= (clientY - lastPosY);
        lastPosX = clientX; lastPosY = clientY;
    }
});
canvas.on('mouse:up', () => { isDragging = false; if(activeTool === 'pan') canvas.defaultCursor = 'grab'; });

canvas.on('selection:created', syncToolbar);
canvas.on('selection:updated', syncToolbar);
canvas.on('text:editing:entered', syncToolbar);

function syncToolbar() {
    let active = canvas.getActiveObject();
    if(active && active.type === 'i-text') {
        document.getElementById('colorPicker').value = active.fill;
        document.getElementById('sizePicker').value = active.fontSize;
        document.getElementById('fontFamily').value = active.fontFamily;
    }
}

document.getElementById('upload-pdf').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    
    try {
        showLoader('Loading PDF...');
        // Fixed: Use standard FileReader for full Samsung Android support
        const arrayBuffer = await readFileAsArrayBuffer(file);
        pdfDoc = await pdfjsLib.getDocument(new Uint8Array(arrayBuffer)).promise;
        pageNum = 1; pageStates = {}; isDirty = false;
        
        document.getElementById('editor-placeholder').classList.add('hidden');
        document.getElementById('canvas-wrapper').classList.remove('hidden');
        
        await renderPage(pageNum, true);
    } catch (error) {
        console.error("PDF Load Error:", error);
        alert("Failed to load PDF. Please try a different file.");
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

async function renderPage(num, autoFit = false) {
    const page = await pdfDoc.getPage(num);
    // Fixed: Keep scale reasonable to prevent Android memory crashes
    const baseViewport = page.getViewport({ scale: 1.5 }); 
    
    // Fixed: Clamp Desktop Auto-Zoom so it doesn't get huge
    if (autoFit) { 
        let availableWidth = document.getElementById('workspace').clientWidth - 40;
        let scaleToFit = availableWidth / baseViewport.width;
        currentZoom = Math.min(scaleToFit, 1.0); // Never zoom in past 100% natively on large screens
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = baseViewport.width; tempCanvas.height = baseViewport.height;
    await page.render({ canvasContext: tempCanvas.getContext('2d'), viewport: baseViewport }).promise;

    canvas.clear(); canvas.setDimensions({ width: baseViewport.width, height: baseViewport.height });
    
    // Fixed: Passing Canvas directly bypasses Android Base64 DataURL size limits
    const img = new fabric.Image(tempCanvas);
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
    let newPage = pageNum + offset;
    if (newPage > 0 && newPage <= pdfDoc.numPages) {
        pageStates[pageNum] = JSON.stringify(canvas); pageNum = newPage; renderPage(pageNum);
    }
}

function updateZoomDisplay() {
    const wrapper = document.getElementById('canvas-wrapper');
    const spacer = document.getElementById('scroll-spacer');
    wrapper.style.transform = `scale(${currentZoom})`;
    if (canvas) {
        spacer.style.width = `${canvas.width * currentZoom}px`;
        spacer.style.height = `${canvas.height * currentZoom}px`;
    }
    canvas.calcOffset();
}

function setZoom(change) { currentZoom = Math.max(0.2, Math.min(3, currentZoom + change)); updateZoomDisplay(); }

function updateStyle() {
    let color = document.getElementById('colorPicker').value;
    let size = parseInt(document.getElementById('sizePicker').value) || 20;
    let font = document.getElementById('fontFamily').value;
    let active = canvas.getActiveObject();
    
    if (active && active.type === 'i-text') { active.set({fill: color, fontSize: size, fontFamily: font}); canvas.renderAll(); isDirty = true; }
    
    if (activeTool === 'highlighter') {
        let r = parseInt(color.substr(1,2),16), g = parseInt(color.substr(3,2),16), b = parseInt(color.substr(5,2),16);
        canvas.freeDrawingBrush.color = `rgba(${r},${g},${b}, 0.3)`;
        canvas.freeDrawingBrush.width = size * 1.5;
    } else {
        canvas.freeDrawingBrush.color = color;
        canvas.freeDrawingBrush.width = size / 4;
    }
}

function deleteSelected() { let active = canvas.getActiveObjects(); if (active.length) { canvas.discardActiveObject(); active.forEach(obj => canvas.remove(obj)); isDirty = true; } }

function handleImageUpload(e) {
    let file = e.target.files[0]; if(!file) return;
    let reader = new FileReader();
    reader.onload = function(f) {
        fabric.Image.fromURL(f.target.result, (img) => {
            img.scaleToWidth(200); img.set({left: canvas.width/2, top: canvas.height/2, originX: 'center', originY: 'center'});
            canvas.add(img); canvas.setActiveObject(img); setTool('pan'); isDirty = true;
        });
    };
    reader.readAsDataURL(file); e.target.value = "";
}

function openSignatureModal() {
    document.getElementById('sig-modal').classList.remove('hidden');
    if(!sigCanvas) {
        sigCanvas = new fabric.Canvas('sig-canvas', { isDrawingMode: true });
        sigCanvas.freeDrawingBrush.width = 3;
    }
    sigCanvas.clear();
}
function clearSignature() { if(sigCanvas) sigCanvas.clear(); }
function saveSignature() {
    if(sigCanvas.getObjects().length === 0) return closeModal('sig-modal');
    fabric.Image.fromURL(sigCanvas.toDataURL('image/png'), (img) => {
        img.set({left: canvas.width/2, top: canvas.height/2, originX: 'center', originY: 'center'});
        canvas.add(img); canvas.setActiveObject(img); setTool('pan'); isDirty = true;
        closeModal('sig-modal');
    });
}

function openExportModal() { if(pdfDoc) document.getElementById('export-modal').classList.remove('hidden'); else alert("Open a PDF first!"); }

async function executeExport() {
    closeModal('export-modal'); showLoader('Saving file...');
    let name = document.getElementById('export-name').value || 'Edited_Document';
    let format = document.getElementById('export-format').value;

    setTimeout(async () => {
        if (format === 'png') {
            let a = document.createElement('a'); a.href = canvas.toDataURL({format: 'png', quality: 1}); a.download = name + '.png'; a.click();
        } else {
            pageStates[pageNum] = JSON.stringify(canvas);
            let newPdf = null;
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: 2.0 });
                const tempCanvas = document.createElement('canvas');
                tempCanvas.height = viewport.height; tempCanvas.width = viewport.width;
                await page.render({ canvasContext: tempCanvas.getContext('2d'), viewport: viewport }).promise;

                const staticCanvas = new fabric.StaticCanvas(null, { width: viewport.width, height: viewport.height });
                await new Promise(r => {
                    const img = new fabric.Image(tempCanvas);
                    staticCanvas.setBackgroundImage(img, () => {
                        if (pageStates[i]) staticCanvas.loadFromJSON(pageStates[i], () => { staticCanvas.renderAll(); r(); }); else r();
                    });
                });

                let imgData = staticCanvas.toDataURL('image/jpeg', 0.8);
                let orient = viewport.width > viewport.height ? 'l' : 'p';
                if (i === 1) newPdf = new jsPDF({ orientation: orient, unit: 'px', format: [viewport.width, viewport.height] });
                else newPdf.addPage([viewport.width, viewport.height], orient);
                newPdf.addImage(imgData, 'JPEG', 0, 0, viewport.width, viewport.height);
            }
            
            let blob = newPdf.output('blob'); let url = URL.createObjectURL(blob);
            let a = document.createElement('a'); a.href = url; a.download = name + '.pdf';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
        }
        isDirty = false;
        hideLoader();
    }, 50);
}

// ==========================================
// MODULE 2: ORGANIZE & QUICK VIEW
// ==========================================
let orgPdfDoc = null, orgPdfJsDoc = null, orgPageArray = [];

document.getElementById('upload-org').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
        showLoader('Processing Pages...');
        document.getElementById('org-upload-box').classList.add('hidden');
        isDirty = false;
        
        const arrayBuffer = await readFileAsArrayBuffer(file);
        orgPdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
        orgPdfJsDoc = await pdfjsLib.getDocument(new Uint8Array(arrayBuffer)).promise;
        orgPageArray = Array.from({length: orgPdfJsDoc.numPages}, (_, i) => i);
        await renderOrganizeGrid();
    } catch (error) {
        console.error(error);
        alert("Error reading PDF.");
        document.getElementById('org-upload-box').classList.remove('hidden');
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

async function renderOrganizeGrid() {
    const grid = document.getElementById('thumbnail-grid'); grid.innerHTML = '';
    
    for(let i=0; i < orgPageArray.length; i++) {
        const page = await orgPdfJsDoc.getPage(orgPageArray[i] + 1);
        const viewport = page.getViewport({ scale: 0.3 }); 
        const fullViewport = page.getViewport({ scale: 1.0 }); 
        
        const wrap = document.createElement('div');
        wrap.className = 'thumb-group relative bg-slate-800 p-2 rounded-lg border border-slate-700 flex flex-col items-center gap-2';
        
        const thumbCanvas = document.createElement('canvas');
        thumbCanvas.className = 'border border-slate-900 peer'; 
        thumbCanvas.height = viewport.height; thumbCanvas.width = viewport.width;
        await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: viewport }).promise;
        
        const previewBox = document.createElement('div');
        previewBox.className = 'preview-box p-3 border-4 border-slate-600 rounded-2xl';
        const previewCanvas = document.createElement('canvas');
        previewCanvas.className = 'max-w-[85vw] max-h-[70vh] object-contain bg-white';
        previewCanvas.height = fullViewport.height; previewCanvas.width = fullViewport.width;
        page.render({ canvasContext: previewCanvas.getContext('2d'), viewport: fullViewport });
        previewBox.appendChild(previewCanvas);
        
        wrap.innerHTML = `<div class="absolute -top-3 -left-3 bg-blue-600 text-white w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shadow">${i+1}</div>`;
        wrap.appendChild(thumbCanvas);
        wrap.appendChild(previewBox); 
        
        const controls = document.createElement('div'); controls.className = 'flex gap-2 w-full justify-center';
        controls.innerHTML = `
            <button onclick="movePage(${i}, -1)" class="bg-slate-700 p-1 px-2 rounded hover:bg-slate-600">◀</button>
            <button onclick="deletePage(${i})" class="text-red-400 p-1 px-2 hover:bg-slate-700 rounded">🗑️</button>
            <button onclick="movePage(${i}, 1)" class="bg-slate-700 p-1 px-2 rounded hover:bg-slate-600">▶</button>
        `;
        wrap.appendChild(controls); grid.appendChild(wrap);
    }
}

function movePage(index, dir) {
    if(index + dir < 0 || index + dir >= orgPageArray.length) return;
    const temp = orgPageArray[index]; orgPageArray[index] = orgPageArray[index + dir]; orgPageArray[index + dir] = temp;
    isDirty = true;
    renderOrganizeGrid();
}
function deletePage(index) {
    orgPageArray.splice(index, 1);
    isDirty = true;
    if(orgPageArray.length === 0) {
        document.getElementById('org-upload-box').classList.remove('hidden');
        document.getElementById('thumbnail-grid').innerHTML = ''; orgPdfDoc = null;
    } else renderOrganizeGrid();
}

async function exportOrganizedPDF(filename) {
    if(!orgPdfDoc || orgPageArray.length === 0) return;
    showLoader('Generating PDF...');
    try {
        const newPdf = await PDFLib.PDFDocument.create();
        const copiedPages = await newPdf.copyPages(orgPdfDoc, orgPageArray);
        copiedPages.forEach(p => newPdf.addPage(p));
        triggerDownload(await newPdf.save(), filename + '.pdf');
        isDirty = false;
    } catch(e) { console.error(e); }
    hideLoader();
}

// ==========================================
// MODULE 3: MERGE PDFs
// ==========================================
let mergeFiles = [];
document.getElementById('upload-merge').addEventListener('change', (e) => {
    mergeFiles = mergeFiles.concat(Array.from(e.target.files));
    isDirty = true;
    e.target.value = '';
    renderMergeList();
});

function renderMergeList() {
    const list = document.getElementById('merge-list'); list.innerHTML = '';
    mergeFiles.forEach((file, index) => {
        list.innerHTML += `
            <div class="bg-slate-800 p-3 rounded-lg border border-slate-700 flex justify-between items-center shadow-sm w-full">
                <div class="truncate mr-4 text-sm font-medium w-full">📄 ${file.name}</div>
                <div class="flex gap-1 shrink-0">
                    <button class="bg-slate-700 px-2 py-1 rounded hover:bg-slate-600" onclick="moveMergeFile(${index}, -1)">🔼</button>
                    <button class="bg-slate-700 px-2 py-1 rounded hover:bg-slate-600" onclick="moveMergeFile(${index}, 1)">🔽</button>
                    <button class="bg-red-900/50 text-red-400 px-2 py-1 rounded hover:bg-red-800" onclick="removeMergeFile(${index})">X</button>
                </div>
            </div>`;
    });
}
function moveMergeFile(index, dir) {
    if(index + dir < 0 || index + dir >= mergeFiles.length) return;
    const temp = mergeFiles[index]; mergeFiles[index] = mergeFiles[index + dir]; mergeFiles[index + dir] = temp;
    isDirty = true;
    renderMergeList();
}
function removeMergeFile(index) { mergeFiles.splice(index, 1); isDirty = true; renderMergeList(); }

async function exportMergedPDF(filename) {
    if(mergeFiles.length < 2) return alert("Select at least 2 PDFs!");
    showLoader('Merging PDFs...');
    try {
        const mergedPdf = await PDFLib.PDFDocument.create();
        for (let file of mergeFiles) {
            const arrayBuffer = await readFileAsArrayBuffer(file);
            const pdf = await PDFLib.PDFDocument.load(arrayBuffer);
            const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
            copiedPages.forEach(p => mergedPdf.addPage(p));
        }
        triggerDownload(await mergedPdf.save(), filename + '.pdf');
        isDirty = false;
    } catch (e) { alert("Error merging files."); }
    hideLoader();
}

// ==========================================
// MODULE 4: SPLIT PDFs
// ==========================================
let splitSelectedPages = new Set();
document.getElementById('upload-split').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
        showLoader('Processing...');
        document.getElementById('split-upload-box').classList.add('hidden');
        isDirty = false;
        
        const arrayBuffer = await readFileAsArrayBuffer(file);
        orgPdfDoc = await PDFLib.PDFDocument.load(arrayBuffer);
        orgPdfJsDoc = await pdfjsLib.getDocument(new Uint8Array(arrayBuffer)).promise;
        splitSelectedPages.clear();
        
        const grid = document.getElementById('split-grid'); grid.innerHTML = '';
        for(let i=0; i < orgPdfJsDoc.numPages; i++) {
            const page = await orgPdfJsDoc.getPage(i + 1);
            const viewport = page.getViewport({ scale: 0.3 });
            const fullViewport = page.getViewport({ scale: 1.0 });
            
            const wrap = document.createElement('div');
            wrap.className = 'thumb-group cursor-pointer border-4 border-transparent rounded-lg transition-colors p-1 bg-slate-800 relative';
            wrap.onclick = () => {
                isDirty = true;
                if(splitSelectedPages.has(i)) { splitSelectedPages.delete(i); wrap.classList.remove('border-blue-500'); }
                else { splitSelectedPages.add(i); wrap.classList.add('border-blue-500'); }
            };
            
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.height = viewport.height; thumbCanvas.width = viewport.width;
            await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: viewport }).promise;
            
            const previewBox = document.createElement('div');
            previewBox.className = 'preview-box p-3 border-4 border-slate-600 rounded-2xl';
            const previewCanvas = document.createElement('canvas');
            previewCanvas.className = 'max-w-[85vw] max-h-[70vh] object-contain bg-white';
            previewCanvas.height = fullViewport.height; previewCanvas.width = fullViewport.width;
            page.render({ canvasContext: previewCanvas.getContext('2d'), viewport: fullViewport });
            previewBox.appendChild(previewCanvas);

            wrap.innerHTML = `<div class="text-center text-xs font-bold text-slate-400 mb-1">Page ${i+1}</div>`;
            wrap.appendChild(thumbCanvas); 
            wrap.appendChild(previewBox);
            grid.appendChild(wrap);
        }
    } catch(err) {
        alert("Error splitting PDF.");
        document.getElementById('split-upload-box').classList.remove('hidden');
    } finally {
        hideLoader();
        e.target.value = '';
    }
});

async function exportSplitPDF(filename) {
    if(!orgPdfDoc || splitSelectedPages.size === 0) return alert("Select pages to extract first!");
    showLoader('Extracting...');
    try {
        const newPdf = await PDFLib.PDFDocument.create();
        const sortedSelected = Array.from(splitSelectedPages).sort((a,b)=>a-b);
        const copiedPages = await newPdf.copyPages(orgPdfDoc, sortedSelected);
        copiedPages.forEach(p => newPdf.addPage(p));
        triggerDownload(await newPdf.save(), filename + '.pdf');
        isDirty = false;
    } catch(e) { console.error(e); }
    hideLoader();
}

function triggerDownload(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 500);
}