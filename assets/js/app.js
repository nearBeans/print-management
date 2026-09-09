const database = new Dexie('papertrailDB');
database.version(1).stores({ prints: '++id, subject, *tags, printNumber, createdAt, updatedAt' });
database.version(2).stores({ prints: '++id, subject, *tags, printNumber, createdAt, updatedAt, syncKey, driveJsonId, driveImageId' });

const state = { prints: [], selectedId: null, subject: 'すべて', query: '', tag: '', worker: null };
const DRIVE_CLIENT_ID = '225116631185-g2mr89e63ftsvbhnpo5btd8s1cboi2jj.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_MANIFEST_NAME = 'papertrail-manifest.json';
const drive = { accessToken: null, tokenClient: null, manifestFile: null };
const elements = {
    grid: document.querySelector('#printGrid'), empty: document.querySelector('#emptyState'), fileInput: document.querySelector('#fileInput'), dropZone: document.querySelector('#dropZone'), queueStatus: document.querySelector('#queueStatus'), search: document.querySelector('#searchInput'), modal: document.querySelector('#editorModal'), form: document.querySelector('#printForm'), image: document.querySelector('#editorImage'), title: document.querySelector('#titleInput'), subject: document.querySelector('#subjectInput'), number: document.querySelector('#numberInput'), tags: document.querySelector('#tagsInput'), ocr: document.querySelector('#ocrInput'), toast: document.querySelector('#toast'), tagButton: document.querySelector('#tagFilterButton'), tagMenu: document.querySelector('#tagMenu'), driveButton: document.querySelector('#driveButton'), driveButtonLabel: document.querySelector('#driveButtonLabel'), syncStatus: document.querySelector('#syncStatus')
};

const dateText = date => new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(new Date(date));
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const imageUrl = blob => URL.createObjectURL(blob);

async function refreshPrints() { state.prints = await database.prints.orderBy('updatedAt').reverse().toArray(); render(); }
function filteredPrints() { return state.prints.filter(print => { const haystack = `${print.title} ${print.ocrText} ${print.tags.join(' ')}`.toLowerCase(); return (state.subject === 'すべて' || print.subject === state.subject) && (!state.query || haystack.includes(state.query.toLowerCase())) && (!state.tag || print.tags.includes(state.tag)); }); }
function render() {
    const prints = filteredPrints();
    elements.grid.innerHTML = prints.map(print => `<article class="print-card"><div class="card-image"><img src="${imageUrl(print.imageBlob)}" alt="${escapeHtml(print.title)}"><span class="subject-badge">${escapeHtml(print.subject)}</span></div><div class="card-body"><h3>${escapeHtml(print.title)}</h3><div class="card-meta"><span>${escapeHtml(print.printNumber || '番号なし')}</span><span>${dateText(print.updatedAt)}</span></div><div class="tag-list">${print.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div><div class="card-actions"><button class="card-action" data-action="pdf" data-id="${print.id}">PDF出力</button><button class="card-action" data-action="edit" data-id="${print.id}">編集 →</button></div></div></article>`).join('');
    elements.empty.style.display = state.prints.length ? (prints.length ? 'none' : 'block') : 'block';
    document.querySelector('#totalCount').textContent = state.prints.length; document.querySelector('#allCount').textContent = state.prints.length;
    ['数学', '英語', '国語', '理科', '社会'].forEach(subject => { const target = { 数学: 'mathCount', 英語: 'englishCount', 国語: 'japaneseCount', 理科: 'scienceCount', 社会: 'socialCount' }[subject]; document.querySelector(`#${target}`).textContent = state.prints.filter(print => print.subject === subject).length; });
    const tags = [...new Set(state.prints.flatMap(print => print.tags))].filter(Boolean); elements.tagMenu.innerHTML = `<button class="tag-choice ${!state.tag ? 'is-selected' : ''}" data-tag="">すべて</button>${tags.map(tag => `<button class="tag-choice ${state.tag === tag ? 'is-selected' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}`;
}
function showToast(message) { elements.toast.textContent = message; elements.toast.classList.add('is-visible'); window.setTimeout(() => elements.toast.classList.remove('is-visible'), 2400); }
function setSyncStatus(message, syncing = false) { elements.syncStatus.textContent = message; elements.syncStatus.classList.toggle('is-syncing', syncing); }
function markLocalChange() { setSyncStatus(drive.accessToken ? '未同期の変更あり' : '未同期'); }
function openEditor(print) { state.selectedId = print.id; elements.image.src = imageUrl(print.imageBlob); elements.title.value = print.title; elements.subject.value = print.subject; elements.number.value = print.printNumber || ''; elements.tags.value = print.tags.join(', '); elements.ocr.value = print.ocrText; elements.modal.hidden = false; elements.title.focus(); }
function closeEditor() { elements.modal.hidden = true; state.selectedId = null; }

async function createWorker() { if (!state.worker) state.worker = await Tesseract.createWorker('jpn+eng', 1, { logger: message => { if (message.status === 'recognizing text') elements.queueStatus.textContent = `OCR解析中... ${Math.round(message.progress * 100)}%`; } }); return state.worker; }
async function processFiles(files) {
    const images = [...files].filter(file => file.type.startsWith('image/')); if (!images.length) return;
    const worker = await createWorker();
    for (let index = 0; index < images.length; index += 1) {
        const file = images[index]; elements.queueStatus.textContent = `${index + 1}/${images.length}枚目を処理中...`; const result = await worker.recognize(file); const detectedNumber = result.data.text.match(/(?:No\.?|№)\s*\d+/i)?.[0] || ''; const now = new Date();
        const print = { title: file.name.replace(/\.[^.]+$/, ''), subject: '未分類', printNumber: detectedNumber, tags: [], imageBlob: file, ocrText: result.data.text.trim(), createdAt: now, updatedAt: now, syncKey: crypto.randomUUID() }; const id = await database.prints.add(print); const saved = await database.prints.get(id); openEditor(saved); await refreshPrints(); markLocalChange(); await new Promise(resolve => { elements.form.addEventListener('submit', () => resolve(), { once: true }); });
    }
    elements.queueStatus.textContent = `${images.length}枚の処理が完了しました。`;
}

function waitForGoogleIdentity() {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const check = () => { if (window.google?.accounts?.oauth2) return resolve(window.google); if (Date.now() - startedAt > 10000) return reject(new Error('Google Identity Servicesの読み込みに失敗しました')); window.setTimeout(check, 100); };
        check();
    });
}

async function requestDriveAccess() {
    if (DRIVE_CLIENT_ID.startsWith('YOUR_')) { showToast('app.jsのGoogle OAuthクライアントIDを設定してください'); return false; }
    try {
        await waitForGoogleIdentity();
        if (!drive.tokenClient) drive.tokenClient = google.accounts.oauth2.initTokenClient({ client_id: DRIVE_CLIENT_ID, scope: DRIVE_SCOPE, callback: response => { if (response.error) { setSyncStatus('認証に失敗'); showToast('Google認証に失敗しました'); return; } drive.accessToken = response.access_token; elements.driveButton.classList.add('is-connected'); elements.driveButtonLabel.textContent = 'Googleと同期'; syncDrive().catch(handleSyncError); } });
        drive.tokenClient.requestAccessToken({ prompt: drive.accessToken ? '' : 'consent' });
        return true;
    } catch (error) { console.error(error); showToast(error.message); return false; }
}

async function driveRequest(path, options = {}) {
    const response = await fetch(`https://www.googleapis.com${path}`, { ...options, headers: { Authorization: `Bearer ${drive.accessToken}`, ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`Google Drive API error: ${response.status}`);
    return response.status === 204 ? null : response.json();
}

async function listDriveFiles() {
    const query = encodeURIComponent("'appDataFolder' in parents and trashed = false");
    const result = await driveRequest(`/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id,name,mimeType,modifiedTime,size)`);
    return result.files || [];
}

async function uploadDriveFile({ id, name, mimeType, body }) {
    const boundary = `papertrail-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name, mimeType, ...(id ? {} : { parents: ['appDataFolder'] }) });
    const multipart = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, body, `\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` });
    const endpoint = id ? `/upload/drive/v3/files/${id}?uploadType=multipart&fields=id,name,modifiedTime` : '/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
    return driveRequest(endpoint, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
}

async function downloadDriveFile(id) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${drive.accessToken}` } });
    if (!response.ok) throw new Error(`Google Drive download error: ${response.status}`);
    return response;
}

function printMetadata(print) { return { title: print.title, subject: print.subject, printNumber: print.printNumber || '', tags: print.tags, ocrText: print.ocrText, createdAt: new Date(print.createdAt).toISOString(), updatedAt: new Date(print.updatedAt).toISOString(), syncKey: print.syncKey, imageType: print.imageBlob?.type || 'image/jpeg' }; }
async function ensureSyncKeys(prints) { for (const print of prints) { if (!print.syncKey) { print.syncKey = crypto.randomUUID(); await database.prints.update(print.id, { syncKey: print.syncKey }); } } return prints; }

async function syncDrive() {
    if (!drive.accessToken) return requestDriveAccess();
    setSyncStatus('同期中...', true); elements.driveButton.disabled = true;
    try {
        const files = await listDriveFiles(); const byName = new Map(files.map(file => [file.name, file])); const remoteManifest = byName.get(DRIVE_MANIFEST_NAME); const localPrints = await ensureSyncKeys(await database.prints.toArray());
        const remoteManifestData = remoteManifest ? await (await downloadDriveFile(remoteManifest.id)).json() : { records: [] }; const remoteRecords = new Map((remoteManifestData.records || []).map(record => [record.syncKey, record]));
        for (const local of localPrints) {
            const remote = remoteRecords.get(local.syncKey); const localTime = new Date(local.updatedAt).getTime(); const remoteTime = remote ? new Date(remote.updatedAt).getTime() : 0;
            if (!remote || localTime > remoteTime) {
                const jsonName = `papertrail-${local.syncKey}.json`; const imageName = `papertrail-${local.syncKey}.${(local.imageBlob.type || 'image/jpeg').split('/')[1] || 'jpg'}`; const jsonFile = await uploadDriveFile({ id: remote?.jsonFileId, name: jsonName, mimeType: 'application/json', body: JSON.stringify(printMetadata(local)) }); const imageFile = await uploadDriveFile({ id: remote?.imageFileId, name: imageName, mimeType: local.imageBlob.type || 'image/jpeg', body: local.imageBlob });
                remoteRecords.set(local.syncKey, { syncKey: local.syncKey, updatedAt: new Date(local.updatedAt).toISOString(), jsonFileId: jsonFile.id, imageFileId: imageFile.id }); await database.prints.update(local.id, { driveJsonId: jsonFile.id, driveImageId: imageFile.id });
            } else if (remoteTime > localTime) {
                const remotePrint = await (await downloadDriveFile(remote.jsonFileId)).json(); const imageResponse = await downloadDriveFile(remote.imageFileId); const imageBlob = await imageResponse.blob(); const existing = local.id ? local : null; const data = { ...remotePrint, imageBlob, createdAt: new Date(remotePrint.createdAt), updatedAt: new Date(remotePrint.updatedAt), driveJsonId: remote.jsonFileId, driveImageId: remote.imageFileId }; if (existing) await database.prints.update(existing.id, data); else await database.prints.add(data);
            }
        }
        const localKeys = new Set((await database.prints.toArray()).map(print => print.syncKey));
        for (const remote of remoteRecords.values()) {
            if (localKeys.has(remote.syncKey) || !remote.jsonFileId || !remote.imageFileId) continue;
            const remotePrint = await (await downloadDriveFile(remote.jsonFileId)).json(); const imageResponse = await downloadDriveFile(remote.imageFileId); const imageBlob = await imageResponse.blob();
            await database.prints.add({ ...remotePrint, imageBlob, createdAt: new Date(remotePrint.createdAt), updatedAt: new Date(remotePrint.updatedAt), driveJsonId: remote.jsonFileId, driveImageId: remote.imageFileId });
        }
        const updatedLocal = await ensureSyncKeys(await database.prints.toArray()); const manifestBody = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), records: [...(await database.prints.toArray())].map(print => { const remote = remoteRecords.get(print.syncKey); return { syncKey: print.syncKey, updatedAt: new Date(print.updatedAt).toISOString(), jsonFileId: remote?.jsonFileId || print.driveJsonId, imageFileId: remote?.imageFileId || print.driveImageId }; }) });
        const manifest = await uploadDriveFile({ id: remoteManifest?.id, name: DRIVE_MANIFEST_NAME, mimeType: 'application/json', body: manifestBody }); drive.manifestFile = manifest; await refreshPrints(); setSyncStatus(`最終同期 ${new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date())}`); showToast('Google Driveと同期しました');
    } finally { elements.driveButton.disabled = false; }
}

function handleSyncError(error) { console.error(error); setSyncStatus('同期エラー'); showToast('Google Driveとの同期に失敗しました'); elements.driveButton.disabled = false; }

elements.fileInput.addEventListener('change', event => processFiles(event.target.files).catch(error => { console.error(error); elements.queueStatus.textContent = 'OCR処理に失敗しました。画像を確認して再試行してください。'; }));
elements.dropZone.addEventListener('dragover', event => { event.preventDefault(); elements.dropZone.classList.add('is-dragging'); });
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-dragging'));
elements.dropZone.addEventListener('drop', event => { event.preventDefault(); elements.dropZone.classList.remove('is-dragging'); processFiles(event.dataTransfer.files); });
elements.search.addEventListener('input', event => { state.query = event.target.value; render(); });
elements.tagButton.addEventListener('click', () => elements.tagMenu.classList.toggle('is-open'));
document.querySelectorAll('[data-subject-filter]').forEach(button => button.addEventListener('click', () => { state.subject = button.dataset.subjectFilter; document.querySelectorAll('.subject-link').forEach(item => item.classList.toggle('is-selected', item === button)); render(); }));
elements.tagMenu.addEventListener('click', event => { if (event.target.dataset.tag !== undefined) { state.tag = event.target.dataset.tag; render(); } });
elements.grid.addEventListener('click', async event => { const button = event.target.closest('[data-action]'); if (!button) return; const print = await database.prints.get(Number(button.dataset.id)); if (button.dataset.action === 'edit') openEditor(print); else downloadPdf([print]); });
elements.driveButton.addEventListener('click', () => { if (drive.accessToken) syncDrive().catch(handleSyncError); else requestDriveAccess(); });
document.querySelector('#closeEditor').addEventListener('click', closeEditor);
elements.modal.addEventListener('click', event => { if (event.target === elements.modal) closeEditor(); });
elements.form.addEventListener('submit', async event => { event.preventDefault(); const print = await database.prints.get(state.selectedId); await database.prints.update(state.selectedId, { title: elements.title.value.trim(), subject: elements.subject.value, printNumber: elements.number.value.trim(), tags: elements.tags.value.split(',').map(tag => tag.trim()).filter(Boolean), ocrText: elements.ocr.value, updatedAt: new Date() }); closeEditor(); await refreshPrints(); markLocalChange(); showToast(`${print?.title || 'プリント'}を保存しました`); });
document.querySelector('#deleteButton').addEventListener('click', async () => { if (!state.selectedId) return; await database.prints.delete(state.selectedId); closeEditor(); await refreshPrints(); markLocalChange(); showToast('プリントを削除しました'); });
document.querySelector('#exportAllButton').addEventListener('click', () => downloadPdf(filteredPrints()));

async function downloadPdf(prints) {
    if (!prints.length) { showToast('書き出すプリントがありません'); return; }
    const pdf = await PDFLib.PDFDocument.create();
    for (const print of prints) { const page = pdf.addPage([595, 842]); const bytes = await print.imageBlob.arrayBuffer(); let image; try { image = print.imageBlob.type === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes); } catch (error) { console.warn(error); } if (image) { const scale = Math.min(535 / image.width, 570 / image.height); page.drawImage(image, { x: 30, y: 242, width: image.width * scale, height: image.height * scale }); } page.drawText(print.title, { x: 30, y: 790, size: 20, color: PDFLib.rgb(.09, .25, .23) }); page.drawText(`${print.subject}  ${print.printNumber || ''}`, { x: 30, y: 770, size: 10, color: PDFLib.rgb(.35, .43, .4) }); const lines = (print.ocrText || '').slice(0, 1800).match(/.{1,54}/g) || []; lines.forEach((line, index) => page.drawText(line, { x: 30, y: 215 - index * 12, size: 8, color: PDFLib.rgb(.18, .22, .2) })); }
    const blob = new Blob([await pdf.save()], { type: 'application/pdf' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `papertrail-${new Date().toISOString().slice(0, 10)}.pdf`; link.click(); showToast(`${prints.length}件をPDFに書き出しました`);
}

refreshPrints().catch(error => { console.error(error); showToast('データベースを初期化できませんでした'); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
