const SUPABASE_URL = 'https://rpgueqafknvrwvrbzixd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TsTrCMyNceS2QH3b2MbpEg_A6MRkade';
let supabaseClient = null;
let currentUser = null;

let appState = {
    items: JSON.parse(localStorage.getItem('indybooks_items') || '[]'),
    folders: JSON.parse(localStorage.getItem('indybooks_folders') || '["Indie Mystery", "Podcasts"]'),
    folderColors: JSON.parse(localStorage.getItem('indybooks_folder_colors') || '{}'),
    goodreadsUser: localStorage.getItem('indybooks_goodreads') || null,
    startTrim: parseInt(localStorage.getItem('indybooks_start_trim') || '0', 10),
    endTrim: parseInt(localStorage.getItem('indybooks_end_trim') || '0', 10),
    currentId: null,
    isPlaying: false,
    slothMode: false,
    sleepTimerTimeout: null
};

const audioEl = document.getElementById('main-audio-element');
let audioCtx = null;
let gainNode = null;

try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    checkSupabaseSession();
} catch (e) {
    console.error('Supabase initialization error:', e);
}

async function checkSupabaseSession() {
    if (!supabaseClient) return;
    const { data } = await supabaseClient.auth.getSession();
    if (data && data.session) {
        currentUser = data.session.user;
        updateAuthUI(true);
        fetchUserLibrary(currentUser.id);
    }
}

async function fetchUserLibrary(userId) {
    if (!supabaseClient || !userId) return;
    const { data, error } = await supabaseClient
        .from('media_items')
        .select('*, bookmarks(*)')
        .eq('user_id', userId);
    if (!error && data && data.length > 0) {
        appState.items = data.map(item => ({
            id: item.id,
            title: item.title,
            author: item.author || '',
            url: item.audio_url,
            folder: item.folder || '',
            cover: item.cover_url || '',
            tags: item.tags || [],
            currentTime: item.current_time || 0,
            duration: item.duration || 0,
            speed: item.speed || 1.0,
            bookmarks: item.bookmarks ? item.bookmarks.map(b => ({ time: b.time, title: b.formatted_time || `Bookmark at ${formatTime(b.time)}` })) : []
        }));
        saveState();
        renderLibrary();
    }
}

async function syncPlaybackProgress(itemId, currentTime) {
    if (!supabaseClient || !currentUser) return;
    await supabaseClient
        .from('media_items')
        .update({ current_time: currentTime })
        .eq('id', itemId);
}

function saveSupabaseConfig() {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    closeModals();
    alert('Supabase connected successfully!');
}

async function supabaseSignUp() {
    if (!supabaseClient) return;
    const email = document.getElementById('auth-email-input').value.trim();
    const password = document.getElementById('auth-pass-input').value.trim();
    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) alert(error.message);
    else alert('Check your email for confirmation link.');
}

async function supabaseSignIn() {
    if (!supabaseClient) return;
    const email = document.getElementById('auth-email-input').value.trim();
    const password = document.getElementById('auth-pass-input').value.trim();
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) alert(error.message);
    else {
        currentUser = data.user;
        updateAuthUI(true);
        fetchUserLibrary(currentUser.id);
        closeModals();
    }
}

async function supabaseSignOut() {
    if (supabaseClient) await supabaseClient.auth.signOut();
    currentUser = null;
    updateAuthUI(false);
    closeModals();
}

function updateAuthUI(isLoggedIn) {
    const unloggedView = document.getElementById('auth-unlogged-view');
    const loggedView = document.getElementById('auth-logged-view');
    const badge = document.getElementById('sync-status-badge');
    const sub = document.getElementById('user-status-subtitle');

    if (isLoggedIn && currentUser) {
        unloggedView.classList.add('hidden');
        loggedView.classList.remove('hidden');
        document.getElementById('auth-user-email').innerText = currentUser.email;
        badge.innerText = 'Synced';
        badge.className = 'text-[10px] bg-green-600 text-white px-1.5 py-0.5 rounded-full font-medium';
        sub.innerText = `Cloud Account: ${currentUser.email}`;
    } else {
        unloggedView.classList.remove('hidden');
        loggedView.classList.add('hidden');
        badge.innerText = 'Local';
        badge.className = 'text-[10px] bg-[#EB8861] text-white px-1.5 py-0.5 rounded-full font-medium';
        sub.innerText = 'Podcast & Audiobook Hub';
    }
}

async function saveStateToCloud(item) {
    if (!supabaseClient || !currentUser) return;
    await supabaseClient.from('media_items').upsert({
        id: item.id,
        user_id: currentUser.id,
        title: item.title,
        author: item.author || '',
        type: 'audiobook',
        audio_url: item.url,
        cover_url: item.cover,
        folder: item.folder,
        tags: item.tags || [],
        current_time: item.currentTime,
        duration: item.duration,
        speed: item.speed
    });
}

function saveState() {
    localStorage.setItem('indybooks_items', JSON.stringify(appState.items));
    localStorage.setItem('indybooks_folders', JSON.stringify(appState.folders));
    localStorage.setItem('indybooks_folder_colors', JSON.stringify(appState.folderColors));
    localStorage.setItem('indybooks_start_trim', appState.startTrim);
    localStorage.setItem('indybooks_end_trim', appState.endTrim);
    if (appState.goodreadsUser) localStorage.setItem('indybooks_goodreads', appState.goodreadsUser);
    else localStorage.removeItem('indybooks_goodreads');

    if (appState.currentId) {
        const cur = appState.items.find(i => i.id === appState.currentId);
        if (cur) saveStateToCloud(cur);
    }
}

window.onload = function() {
    renderLibrary();
    updateFolderDropdowns();
    updateGoodreadsUI();
    setupAudioContext();
    document.getElementById('global-start-trim').value = appState.startTrim;
    document.getElementById('global-end-trim').value = appState.endTrim;
};

function setupAudioContext() {
    if (audioCtx) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(audioEl);
        gainNode = audioCtx.createGain();
        source.connect(gainNode);
        gainNode.connect(audioCtx.destination);
    } catch (e) {
        console.warn('Web Audio API volume node not supported:', e);
    }
}

function adjustAppVolume(val) {
    const v = parseFloat(val);
    if (gainNode) {
        gainNode.gain.value = v;
    } else {
        audioEl.volume = Math.min(1.0, v);
    }
    document.getElementById('volume-label').innerText = `${Math.round(v * 100)}%`;
}

function saveGoodreadsAccount() {
    const val = document.getElementById('goodreads-user-id').value.trim();
    if (!val) return;
    appState.goodreadsUser = val;
    saveState();
    updateGoodreadsUI();
    closeGoodreadsModal();
}

function disconnectGoodreads() {
    appState.goodreadsUser = null;
    saveState();
    updateGoodreadsUI();
    closeGoodreadsModal();
}

function updateGoodreadsUI() {
    const unlogged = document.getElementById('goodreads-unlogged');
    const logged = document.getElementById('goodreads-logged');
    if (appState.goodreadsUser) {
        unlogged.classList.add('hidden');
        logged.classList.remove('hidden');
        document.getElementById('goodreads-account-display').innerText = `Linked ID: ${appState.goodreadsUser}`;
    } else {
        unlogged.classList.remove('hidden');
        logged.classList.add('hidden');
    }
}

function importGoodreadsCSV(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        const lines = text.split('\n');
        lines.forEach((line, idx) => {
            if (idx === 0 || !line.trim()) return;
            const cols = line.split(',');
            if (cols.length > 1) {
                const title = cols[1] ? cols[1].replace(/"/g, '').trim() : 'Goodreads Import';
                const author = cols[2] ? cols[2].replace(/"/g, '').trim() : 'Unknown Author';
                const newItem = {
                    id: 'gr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                    title: title,
                    author: author,
                    url: '',
                    folder: 'Goodreads Books',
                    cover: '',
                    tags: ['goodreads', 'reading-goal'],
                    currentTime: 0,
                    duration: 0,
                    speed: 1.0,
                    bookmarks: []
                };
                if (!appState.folders.includes('Goodreads Books')) appState.folders.push('Goodreads Books');
                appState.items.push(newItem);
                saveStateToCloud(newItem);
            }
        });
        saveState();
        renderLibrary();
        updateFolderDropdowns();
        closeGoodreadsModal();
    };
    reader.readAsText(file);
}

function playWildcard() {
    if (appState.items.length === 0) return;
    const playable = appState.items.filter(i => i.url);
    if (playable.length === 0) {
        alert('No playable items with direct audio URLs in your library.');
        return;
    }
    const randIndex = Math.floor(Math.random() * playable.length);
    playItem(playable[randIndex].id);
    openPlayerModal();
}

function renderLibrary() {
    const container = document.getElementById('library-container');
    container.innerHTML = '';

    if (appState.items.length === 0) {
        container.innerHTML = `
            <div class="text-center py-16 px-4 bg-white rounded-2xl border border-dashed border-gray-300 shadow-sm">
                <div class="w-16 h-16 mx-auto mb-3 rounded-full bg-[#C3D7EA]/40 flex items-center justify-center text-[#4173B0]">
                    <i class="fa-solid fa-headphones text-2xl"></i>
                </div>
                <h3 class="text-base font-bold text-[#2B4C6D]">Your Library is Empty</h3>
                <p class="text-xs text-gray-500 mt-1 max-w-xs mx-auto">Add an RSS feed, link an audio URL, upload local files, or click Wildcard!</p>
            </div>
        `;
        return;
    }

    appState.folders.forEach(folder => {
        const folderItems = appState.items.filter(item => item.folder === folder);
        const folderColor = appState.folderColors[folder] || '#4173B0';
        const folderEl = document.createElement('div');
        folderEl.className = 'bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden';
        folderEl.innerHTML = `
            <div class="px-4 py-3 bg-gray-50 flex items-center justify-between border-b border-gray-100">
                <div class="flex items-center space-x-2 font-semibold text-sm text-[#2B4C6D]">
                    <i class="fa-solid fa-folder" style="color: ${folderColor}"></i>
                    <span>${folder}</span>
                    <span class="text-xs text-gray-400 font-normal">(${folderItems.length})</span>
                </div>
                <button onclick="deleteFolder('${folder}')" class="text-xs text-red-500 hover:text-red-700 p-1" title="Delete Folder">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="divide-y divide-gray-100">
                ${folderItems.length === 0 ? '<div class="p-3 text-xs text-gray-400 italic text-center">Folder is empty</div>' : folderItems.map(item => renderItemCard(item)).join('')}
            </div>
        `;
        container.appendChild(folderEl);
    });

    const ungroupedItems = appState.items.filter(item => !item.folder || !appState.folders.includes(item.folder));
    if (ungroupedItems.length > 0) {
        const ungroupedEl = document.createElement('div');
        ungroupedEl.className = 'bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden divide-y divide-gray-100';
        ungroupedEl.innerHTML = ungroupedItems.map(item => renderItemCard(item)).join('');
        container.appendChild(ungroupedEl);
    }
}

function renderItemCard(item) {
    const pct = item.duration ? Math.min(100, Math.round((item.currentTime / item.duration) * 100)) : 0;
    const timeRemaining = item.duration ? formatTime(item.duration - item.currentTime) : '--:--';
    const isCurrent = appState.currentId === item.id;
    const tagsHtml = item.tags && item.tags.length > 0 ? item.tags.map(t => `<span class="text-[9px] bg-gray-100 text-[#4173B0] px-1.5 py-0.5 rounded-md font-medium">#${t.trim()}</span>`).join(' ') : '';

    return `
        <div class="p-3 flex items-center justify-between hover:bg-gray-50/80 transition ${isCurrent ? 'bg-[#C3D7EA]/20 border-l-4 border-[#4173B0]' : ''}">
            <div class="flex items-center space-x-3 flex-1 min-w-0 cursor-pointer" onclick="playItem('${item.id}')">
                <div class="w-12 h-12 rounded-xl bg-gray-100 overflow-hidden shrink-0 shadow-sm flex items-center justify-center">
                    ${item.cover ? `<img src="${item.cover}" class="w-full h-full object-cover">` : '<i class="fa-solid fa-music text-gray-400"></i>'}
                </div>
                <div class="min-w-0 flex-1">
                    <h4 class="text-xs font-bold text-[#2B4C6D] truncate">${item.title}</h4>
                    <p class="text-[11px] text-gray-600 truncate">${item.author || 'Unknown Author'}</p>
                    <div class="flex items-center space-x-2 mt-1">
                        <div class="flex-1 bg-gray-200 h-1.5 rounded-full overflow-hidden max-w-[120px]">
                            <div class="bg-[#4173B0] h-full" style="width: ${pct}%"></div>
                        </div>
                        <span class="text-[10px] text-gray-500">${pct}% • ${timeRemaining}</span>
                    </div>
                    ${tagsHtml ? `<div class="flex flex-wrap gap-1 mt-1.5">${tagsHtml}</div>` : ''}
                </div>
            </div>
            <div class="flex items-center space-x-1 ml-2">
                <button onclick="openEditModal('${item.id}')" class="w-8 h-8 rounded-full hover:bg-gray-200 flex items-center justify-center text-gray-500" title="Edit"><i class="fa-solid fa-ellipsis-vertical text-xs"></i></button>
                <button onclick="deleteItem('${item.id}')" class="w-8 h-8 rounded-full hover:bg-red-50 flex items-center justify-center text-red-500" title="Delete"><i class="fa-solid fa-trash text-xs"></i></button>
            </div>
        </div>
    `;
}

function playItem(id) {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    const item = appState.items.find(i => i.id === id);
    if (!item) return;

    appState.currentId = id;
    if (!item.url) {
        alert('This item is a Goodreads log or missing a direct audio stream URL.');
        return;
    }
    audioEl.src = item.url;
    audioEl.playbackRate = appState.slothMode ? 0.5 : (item.speed || 1.0);
    
    audioEl.onerror = () => {
        alert('Playback error: Local browser codec support for .m4b / .mp4 files may vary or the URL is blocked.');
        appState.isPlaying = false;
        updatePlayerUI();
    };

    audioEl.onloadedmetadata = () => {
        item.duration = audioEl.duration;
        audioEl.currentTime = Math.max(appState.startTrim, item.currentTime || appState.startTrim);
        audioEl.play().catch(err => console.warn("Autoplay blocked:", err));
        appState.isPlaying = true;
        updatePlayerUI();
        renderLibrary();
        setupMediaSession(item);
    };
    audioEl.load();
}

function setupMediaSession(item) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: item.title,
            artist: item.author || 'IndyBooks',
            album: item.folder || 'Podcast & Audiobook Hub',
            artwork: item.cover ? [{ src: item.cover, sizes: '512x512', type: 'image/jpeg' }] : []
        });
        navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
        navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
        navigator.mediaSession.setActionHandler('seekbackward', () => skipTime(-15));
        navigator.mediaSession.setActionHandler('seekforward', () => skipTime(30));
    }
}

function deleteItem(id) {
    if (!confirm('Are you sure you want to delete this audio item?')) return;
    if (appState.currentId === id) {
        audioEl.pause();
        appState.currentId = null;
        appState.isPlaying = false;
        updatePlayerUI();
    }
    appState.items = appState.items.filter(i => i.id !== id);
    saveState();
    renderLibrary();
}

function deleteFolder(folderName) {
    if (!confirm(`Are you sure you want to delete the folder "${folderName}"? Items inside will become ungrouped.`)) return;
    appState.folders = appState.folders.filter(f => f !== folderName);
    delete appState.folderColors[folderName];
    appState.items.forEach(i => {
        if (i.folder === folderName) i.folder = '';
    });
    saveState();
    renderLibrary();
    updateFolderDropdowns();
}

function togglePlayPause() {
    if (!appState.currentId && appState.items.length > 0) {
        playItem(appState.items[0].id);
        return;
    }
    if (audioEl.paused) {
        audioEl.play();
        appState.isPlaying = true;
    } else {
        audioEl.pause();
        appState.isPlaying = false;
    }
    updatePlayerUI();
}

function onAudioTimeUpdate() {
    if (!appState.currentId) return;
    const currentItem = appState.items.find(i => i.id === appState.currentId);
    if (!currentItem) return;

    currentItem.currentTime = audioEl.currentTime;
    currentItem.duration = audioEl.duration || currentItem.duration;

    if (appState.endTrim > 0 && currentItem.duration && audioEl.currentTime >= (currentItem.duration - appState.endTrim)) {
        audioEl.pause();
        appState.isPlaying = false;
        updatePlayerUI();
        return;
    }

    saveState();
    syncPlaybackProgress(currentItem.id, audioEl.currentTime);
    updatePlayerProgressUI();
}

function updatePlayerProgressUI() {
    const currentItem = appState.items.find(i => i.id === appState.currentId);
    if (!currentItem || !currentItem.duration) return;

    const pct = (audioEl.currentTime / currentItem.duration) * 100;
    document.getElementById('mini-progress').style.width = `${pct}%`;
    document.getElementById('modal-seek-slider').value = audioEl.currentTime;
    document.getElementById('modal-seek-slider').max = currentItem.duration;
    document.getElementById('current-time-label').innerText = formatTime(audioEl.currentTime);
    document.getElementById('total-time-label').innerText = formatTime(currentItem.duration);
    document.getElementById('modal-time-remaining').innerText = `Time remaining: ${formatTime(currentItem.duration - audioEl.currentTime)}`;
    document.getElementById('modal-listened-pct').innerText = `${Math.round(pct)}% listened`;
}

function updatePlayerUI() {
    const currentItem = appState.items.find(i => i.id === appState.currentId);
    const playBtnMini = document.getElementById('mini-play-btn');
    const playBtnModal = document.getElementById('modal-play-btn');

    if (appState.isPlaying) {
        playBtnMini.innerHTML = '<i class="fa-solid fa-pause text-sm"></i>';
        playBtnModal.innerHTML = '<i class="fa-solid fa-pause"></i>';
    } else {
        playBtnMini.innerHTML = '<i class="fa-solid fa-play text-sm ml-0.5"></i>';
        playBtnModal.innerHTML = '<i class="fa-solid fa-play ml-1"></i>';
    }

    if (currentItem) {
        document.getElementById('mini-title').innerText = currentItem.title;
        document.getElementById('mini-subtitle').innerText = `${currentItem.author || 'Unknown'} • ${currentItem.folder || 'Ungrouped'}`;
        document.getElementById('modal-title').innerText = currentItem.title;
        document.getElementById('modal-subtitle').innerText = currentItem.author || 'IndyBooks Audio';
        document.getElementById('modal-org-title').innerText = currentItem.title;
        if (currentItem.cover) {
            document.getElementById('mini-cover').innerHTML = `<img src="${currentItem.cover}" class="w-full h-full object-cover">`;
            document.getElementById('modal-cover-container').innerHTML = `<img src="${currentItem.cover}" class="w-full h-full object-cover">`;
        }
    }
    document.getElementById('speed-label').innerText = `${(audioEl.playbackRate || 1.0).toFixed(1)}x`;
}

function skipTime(seconds) {
    if (!appState.currentId) return;
    audioEl.currentTime = Math.max(0, Math.min(audioEl.duration || 0, audioEl.currentTime + seconds));
}

function adjustSpeed(delta) {
    if (appState.slothMode) return;
    let newRate = Math.max(0.5, Math.min(3.0, (audioEl.playbackRate || 1.0) + delta));
    audioEl.playbackRate = newRate;
    const currentItem = appState.items.find(i => i.id === appState.currentId);
    if (currentItem) currentItem.speed = newRate;
    saveState();
    updatePlayerUI();
}

function toggleSlothMode() {
    appState.slothMode = !appState.slothMode;
    const btn = document.getElementById('sloth-mode-btn');
    const modalBtn = document.getElementById('modal-sloth-btn');
    
    if (appState.slothMode) {
        audioEl.playbackRate = 0.5;
        btn.classList.add('bg-white/35', 'ring-2', 'ring-[#EB8861]');
        if (modalBtn) modalBtn.classList.add('text-[#EB8861]', 'scale-105');
    } else {
        const currentItem = appState.items.find(i => i.id === appState.currentId);
        audioEl.playbackRate = currentItem ? (currentItem.speed || 1.0) : 1.0;
        btn.classList.remove('bg-white/35', 'ring-2', 'ring-[#EB8861]');
        if (modalBtn) modalBtn.classList.remove('text-[#EB8861]', 'scale-105');
    }
    updatePlayerUI();
}

function handleLocalFiles(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach(file => {
        const url = URL.createObjectURL(file);
        const baseName = file.name.replace(/\.[^/.]+$/, "");
        const newItem = {
            id: 'item_' + Date.now() + Math.random().toString(36).substr(2, 5),
            title: baseName,
            author: file.name.endsWith('.m4b') ? 'Audiobook' : 'Local Import',
            url: url,
            folder: file.name.endsWith('.m4b') ? 'Audiobooks' : '',
            cover: '',
            tags: ['local', file.name.split('.').pop().toLowerCase()],
            currentTime: 0,
            duration: 0,
            speed: 1.0,
            bookmarks: []
        };
        if (file.name.endsWith('.m4b') && !appState.folders.includes('Audiobooks')) {
            appState.folders.push('Audiobooks');
            appState.folderColors['Audiobooks'] = '#4173B0';
        }
        appState.items.push(newItem);
        saveStateToCloud(newItem);
    });
    saveState();
    renderLibrary();
    updateFolderDropdowns();
}

function addAudioFromUrl() {
    const authorInput = document.getElementById('direct-author-input').value.trim();
    const titleInput = document.getElementById('direct-title-input').value.trim();
    const urlInput = document.getElementById('direct-url-input').value.trim();
    const coverInput = document.getElementById('direct-cover-input').value.trim();
    const folderSelect = document.getElementById('direct-folder-select').value;

    if (!urlInput) return;

    const newItem = {
        id: 'url_' + Date.now() + Math.random().toString(36).substr(2, 5),
        title: titleInput || 'Linked Audio',
        author: authorInput || 'Unknown Author',
        url: urlInput,
        folder: folderSelect,
        cover: coverInput,
        tags: ['stream'],
        currentTime: 0,
        duration: 0,
        speed: 1.0,
        bookmarks: []
    };

    appState.items.push(newItem);
    saveStateToCloud(newItem);
    saveState();
    renderLibrary();
    closeModals();
}

async function ingestRssFeed() {
    const urlInput = document.getElementById('rss-url-input').value.trim();
    if (!urlInput) return;
    try {
        let xmlText = '';
        const proxies = [
            `https://api.allorigins.win/raw?url=${encodeURIComponent(urlInput)}`,
            `https://corsproxy.io/?${encodeURIComponent(urlInput)}`
        ];

        for (const proxyUrl of proxies) {
            try {
                const res = await fetch(proxyUrl);
                if (res.ok) {
                    xmlText = await res.text();
                    if (xmlText && xmlText.includes('<rss') || xmlText.includes('<feed') || xmlText.includes('<?xml')) {
                        break;
                    }
                }
            } catch (e) {
                console.warn('Proxy fetch attempt failed:', e);
            }
        }

        if (!xmlText) throw new Error('Could not retrieve RSS XML through CORS proxies.');

        const parser = new DOMParser();
        const xml = parser.parseFromString(xmlText, "text/xml");
        if (xml.querySelector('parsererror')) {
            throw new Error('XML parsing error in feed response.');
        }

        const channelTitle = xml.querySelector('channel > title, feed > title')?.textContent || 'Podcast Feed';
        const channelAuthor = xml.querySelector('channel > author, channel > *|author, channel > *|owner > *|name, feed > author > name')?.textContent || 'Podcast Creator';
        const items = xml.querySelectorAll('item, entry');

        if (!appState.folders.includes(channelTitle)) {
            appState.folders.push(channelTitle);
            appState.folderColors[channelTitle] = '#4173B0';
        }

        items.forEach((item, index) => {
            if (index > 25) return;
            const title = item.querySelector('title')?.textContent || 'Episode';
            const enclosure = item.querySelector('enclosure');
            const audioUrl = enclosure ? enclosure.getAttribute('url') : (item.querySelector('link[rel="enclosure"]')?.getAttribute('href') || '');
            const itunesImage = item.querySelector('image, *|image, *|itunes\\:image')?.getAttribute('href') || item.querySelector('itunes\\:image')?.getAttribute('url') || '';

            if (audioUrl) {
                const newItem = {
                    id: 'rss_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                    title: title,
                    author: channelAuthor,
                    url: audioUrl,
                    folder: channelTitle,
                    cover: itunesImage,
                    tags: ['podcast'],
                    currentTime: 0,
                    duration: 0,
                    speed: 1.0,
                    bookmarks: []
                };
                appState.items.push(newItem);
                saveStateToCloud(newItem);
            }
        });
        saveState();
        renderLibrary();
        updateFolderDropdowns();
        closeModals();
    } catch (err) {
        alert('Could not parse RSS feed: ' + err.message);
    }
}

function createFolder() {
    const name = document.getElementById('folder-name-input').value.trim();
    const color = document.getElementById('folder-color-input').value;
    if (name && !appState.folders.includes(name)) {
        appState.folders.push(name);
        appState.folderColors[name] = color;
        saveState();
        renderLibrary();
        updateFolderDropdowns();
        closeModals();
    }
}

function updateFolderDropdowns() {
    const selects = [document.getElementById('edit-folder-select'), document.getElementById('direct-folder-select')];
    selects.forEach(select => {
        if (!select) return;
        select.innerHTML = '<option value="">(None - Ungrouped)</option>';
        appState.folders.forEach(f => {
            select.innerHTML += `<option value="${f}">${f}</option>`;
        });
    });
}

function openPlayerModal() { document.getElementById('player-modal').classList.remove('translate-y-full'); }
function closePlayerModal() { document.getElementById('player-modal').classList.add('translate-y-full'); }
function openAuthModal() { document.getElementById('auth-modal').classList.remove('hidden'); document.getElementById('auth-modal').classList.add('flex'); }

function openGoodreadsModal() { 
    closeModals();
    const gm = document.getElementById('goodreads-modal');
    gm.classList.remove('hidden'); 
    gm.classList.add('flex'); 
}
function closeGoodreadsModal() {
    document.getElementById('goodreads-modal').classList.add('hidden');
    document.getElementById('goodreads-modal').classList.remove('flex');
}

function openAddFeedModal() { document.getElementById('add-feed-modal').classList.remove('hidden'); document.getElementById('add-feed-modal').classList.add('flex'); }
function openAddUrlModal() { updateFolderDropdowns(); document.getElementById('add-url-modal').classList.remove('hidden'); document.getElementById('add-url-modal').classList.add('flex'); }
function openCreateFolderModal() { document.getElementById('create-folder-modal').classList.remove('hidden'); document.getElementById('create-folder-modal').classList.add('flex'); }
function openSettingsModal() { document.getElementById('settings-modal').classList.remove('hidden'); document.getElementById('settings-modal').classList.add('flex'); }
function openSearchModal() { 
    buildTagCloud();
    document.getElementById('search-modal').classList.remove('hidden'); 
    document.getElementById('search-modal').classList.add('flex'); 
}
function openSleepTimerModal() { document.getElementById('sleep-timer-modal').classList.remove('hidden'); document.getElementById('sleep-timer-modal').classList.add('flex'); }
function openBookmarksModal() { renderBookmarksList(); document.getElementById('bookmarks-modal').classList.remove('hidden'); document.getElementById('bookmarks-modal').classList.add('flex'); }

function openEditModal(id) {
    const item = appState.items.find(i => i.id === id);
    if (!item) return;
    document.getElementById('edit-item-id').value = item.id;
    document.getElementById('edit-author-input').value = item.author || '';
    document.getElementById('edit-title-input').value = item.title;
    document.getElementById('edit-cover-input').value = item.cover || '';
    document.getElementById('edit-folder-select').value = item.folder || '';
    document.getElementById('edit-tags-input').value = item.tags ? item.tags.join(', ') : '';
    document.getElementById('edit-item-modal').classList.remove('hidden');
    document.getElementById('edit-item-modal').classList.add('flex');
}

function handleCoverImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('edit-cover-input').value = e.target.result;
    };
    reader.readAsDataURL(file);
}

function closeModals() {
    document.querySelectorAll('[id$="-modal"]').forEach(m => {
        if (m.id !== 'goodreads-modal') {
            m.classList.add('hidden');
            m.classList.remove('flex');
        }
    });
    closeGoodreadsModal();
}

function saveItemEdits() {
    const id = document.getElementById('edit-item-id').value;
    const item = appState.items.find(i => i.id === id);
    if (!item) return;
    item.author = document.getElementById('edit-author-input').value.trim() || item.author;
    item.title = document.getElementById('edit-title-input').value.trim() || item.title;
    item.cover = document.getElementById('edit-cover-input').value.trim() || item.cover;
    item.folder = document.getElementById('edit-folder-select').value;
    const rawTags = document.getElementById('edit-tags-input').value;
    item.tags = rawTags ? rawTags.split(',').map(t => t.trim()).filter(Boolean) : [];
    saveStateToCloud(item);
    saveState();
    renderLibrary();
    closeModals();
}

function saveAppSettings() {
    appState.startTrim = parseInt(document.getElementById('global-start-trim').value || '0', 10);
    appState.endTrim = parseInt(document.getElementById('global-end-trim').value || '0', 10);
    saveState();
    closeModals();
}

function addBookmark() {
    const item = appState.items.find(i => i.id === appState.currentId);
    if (!item) return;
    if (!item.bookmarks) item.bookmarks = [];
    item.bookmarks.push({ time: audioEl.currentTime, title: `Bookmark at ${formatTime(audioEl.currentTime)}` });
    saveState();
}

function renderBookmarksList() {
    const item = appState.items.find(i => i.id === appState.currentId);
    const list = document.getElementById('bookmarks-list');
    if (!item || !item.bookmarks || item.bookmarks.length === 0) {
        list.innerHTML = '<div class="text-center text-xs text-gray-400 py-6">No bookmarks saved yet.</div>';
        return;
    }
    list.innerHTML = item.bookmarks.map((b) => `
        <div class="py-2.5 flex items-center justify-between">
            <div>
                <h5 class="text-xs font-bold text-[#2B4C6D]">${b.title}</h5>
                <span class="text-[10px] text-gray-400">${formatTime(b.time)}</span>
            </div>
            <button onclick="audioEl.currentTime = ${b.time}; closeModals();" class="px-3 py-1 bg-[#4173B0] text-white text-xs rounded-lg">Jump</button>
        </div>
    `).join('');
}

function setSleepTimer(minutes) {
    if (appState.sleepTimerTimeout) clearTimeout(appState.sleepTimerTimeout);
    appState.sleepTimerTimeout = setTimeout(() => {
        audioEl.pause();
        appState.isPlaying = false;
        updatePlayerUI();
    }, minutes * 60 * 1000);
    closeModals();
}

function cancelSleepTimer() {
    if (appState.sleepTimerTimeout) clearTimeout(appState.sleepTimerTimeout);
    closeModals();
}

function exportLibrary() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "indybooks_backup.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

function buildTagCloud() {
    const cloud = document.getElementById('tag-cloud');
    const allTags = new Set();
    appState.items.forEach(i => {
        if (i.tags) i.tags.forEach(t => allTags.add(t));
    });
    if (allTags.size === 0) {
        cloud.innerHTML = '<span class="text-[10px] text-gray-400 italic">No tags created yet. Add tags in Edit Details.</span>';
        return;
    }
    let html = '';
    allTags.forEach(tag => {
        html += `<button onclick="filterByTag('${tag}')" class="text-[10px] bg-[#C3D7EA]/40 text-[#2B4C6D] px-2 py-1 rounded-lg font-semibold hover:bg-[#C3D7EA]">#${tag}</button>`;
    });
    cloud.innerHTML = html;
}

function filterByTag(tag) {
    document.getElementById('search-input').value = `#${tag}`;
    handleSearch(`#${tag}`);
}

function handleSearch(query) {
    const results = document.getElementById('search-results');
    if (!query.trim()) { results.innerHTML = ''; return; }
    const q = query.toLowerCase();
    const matches = appState.items.filter(i => {
        const matchTitle = i.title.toLowerCase().includes(q);
        const matchAuthor = i.author && i.author.toLowerCase().includes(q);
        const matchFolder = i.folder && i.folder.toLowerCase().includes(q);
        const matchTag = i.tags && i.tags.some(t => `#${t.toLowerCase()}`.includes(q) || t.toLowerCase().includes(q));
        return matchTitle || matchAuthor || matchFolder || matchTag;
    });
    results.innerHTML = matches.length === 0 ? '<div class="text-xs text-gray-400 text-center py-4">No results found</div>' : matches.map(m => `
        <div class="p-2 hover:bg-gray-50 rounded-xl cursor-pointer flex items-center justify-between" onclick="playItem('${m.id}'); closeModals();">
            <span class="text-xs font-semibold text-[#2B4C6D] truncate">${m.title}</span>
            <span class="text-[10px] text-gray-400">${m.folder || 'Ungrouped'}</span>
        </div>
    `).join('');
}

function seekAudioBar(event) {
    const currentItem = appState.items.find(i => i.id === appState.currentId);
    if (!currentItem || !currentItem.duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pos = (event.clientX - rect.left) / rect.width;
    audioEl.currentTime = pos * currentItem.duration;
}

function onSeekInput(val) {}
function onSeekChange(val) { audioEl.currentTime = parseFloat(val); }

function formatTime(secs) {
    if (isNaN(secs)) return "0:00";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}