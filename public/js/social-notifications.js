
// ═══════════════════════════════════════════════════════════════
// SOCIAL SYSTEM & NOTIFICATIONS — Frontend Implementation (v6.0)
// ═══════════════════════════════════════════════════════════════

// Global state
let currentSocialTab = 'forum';
let currentSocialPage = 1;
let currentSocialType = 'forum';
let openPostId = null;
let notificationsLoaded = false;

// ── SVG ICON HELPERS ──
const _sv = {
  heart: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
};

function _t(msg, kind) { showMsg('social-posts-list', msg, kind); }

const SOCIAL_POST_CHAR_LIMIT = 3000;
const SOCIAL_COMMENT_CHAR_LIMIT = 300;
const SOCIAL_BAD_WORDS = [
  'merda','porra','caralho','foda','puta','piranha','buceta','viado','viado','otario','otário','arrombado','burra','burro','idiota','estupido','estúpido','babaca','filhoda','filho da puta','puta que pariu','desgraça','vaca'
];

function normalizeBadWordText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function containsBadWords(text) {
  const normalized = normalizeBadWordText(text);
  return SOCIAL_BAD_WORDS.some(word => {
    const safeWord = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return new RegExp(`\\b${safeWord}\\b`, 'i').test(normalized);
  });
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function preserveSocialSpaces(text) {
  return String(text || '').replace(/ {2,}/g, spaces => '&nbsp;'.repeat(spaces.length - 1) + ' ');
}

function formatSocialText(text) {
  if (!text) return '';
  let html = escapeHtml(text.trim());
  html = preserveSocialSpaces(html);
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  return html
    .split(/\n{2,}/g)
    .map(block => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function formatSocialPreview(text) {
  if (!text) return '';
  let trimmed = String(text || '').replace(/\n/g, ' ').replace(/\*\*|~~|\*/g, '');
  trimmed = preserveSocialSpaces(trimmed);
  return trimmed.length > 200 ? trimmed.substring(0, 197).trim() + '…' : trimmed;
}

function openSocialComposer() {
  const modal = document.getElementById('social-compose-modal');
  const titleInput = document.getElementById('social-title-input');
  const contentInput = document.getElementById('social-content-input');
  const typeLabel = document.getElementById('social-compose-type');
  const typeText = currentSocialTab === 'updates' ? 'Atualização' : 'Fórum';

  typeLabel.textContent = typeText;
  titleInput.value = '';
  contentInput.value = '';
  titleInput.placeholder = currentSocialTab === 'updates' ? 'Título da atualização' : 'Título do post';
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  setTimeout(() => contentInput.focus(), 50);
  // update char counter immediately
  updateComposeCharCount();
  // ensure listener attached (in case DOM mutations removed it)
  _composeAttach();
}

// ─── SVG ICON HELPERS ──

// ─── SOCIAL TAB SWITCHING ───
function showSocialTab(tab, skipHashUpdate = false) {
  currentSocialTab = tab;
  currentSocialType = tab === 'updates' ? 'update' : 'forum';
  currentSocialPage = 1;
  
  document.querySelectorAll('.social-tab').forEach(b => b.classList.remove('active'));
  document.querySelector(`.social-tab[data-tab="${tab}"]`).classList.add('active');
  
  const newPostBtn = document.getElementById('social-new-post-btn');
  const canPost = CU && (tab === 'forum' || ['admin', 'dev'].includes(CU.role));
  newPostBtn.style.display = canPost ? '' : 'none';
  if (!skipHashUpdate) {
    history.replaceState(null, '', `#/social${tab === 'updates' ? '/updates' : ''}`);
  }
  loadSocialPage(1);
}

// ─── LOAD SOCIAL PAGE ───
async function loadSocialPage(page) {
  try {
    setPageLoading('social', true);
    const type = currentSocialType;
    const { posts, total } = await GET(`social/posts?type=${type}&page=${page}&limit=20`);
    
    currentSocialPage = page;
    renderSocialPosts(posts);
    updateSocialPagination(total, page);
  } catch (e) {
    showMsg('social-posts-list', e.message, 'err');
  } finally {
    setPageLoading('social', false);
  }
}

// ─── RENDER POSTS ───
function renderSocialPosts(posts) {
  const list = document.getElementById('social-posts-list');
  if (!posts.length) {
    list.innerHTML = '<p class="page-hint">Nenhum post ainda.</p>';
    return;
  }
  
  list.innerHTML = posts.map(p => {
    const isOwner = CU && String(CU.id) === String(p.author_id);
    const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
    const createdDate = new Date(p.created_at).toLocaleDateString('pt-BR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const ic = {pin:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11-1.79V4A2 2 0 0 1 10 2h4a2 2 0 0 1 2 2v4.95"/></svg>`, lock:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`, heart:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`, comment:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`, trash:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`, edit:`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`, check:`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` };
    const isPinned = p.is_pinned ? ic.pin : '';
    const isLocked = p.is_locked ? ic.lock : '';
    const authorEmoji = p.author ? (p.author.avatar || '🦁') : '🦁';
    const authorPhoto = p.author && p.author.photo ? `<img src="${p.author.photo}" alt="${authorEmoji}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='${authorEmoji}'">` : `<span style="font-size:24px;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--s3)">${authorEmoji}</span>`;
    return `<div class="card social-post-card" style="margin-bottom:14px;cursor:pointer" onclick="openSocialPost(${p.id})">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex-shrink:0">${authorPhoto}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="font-weight:600;font-size:13px">${p.author ? escapeHtml(p.author.nick || p.author.name) : 'Anônimo'}</span>
            ${p.author && p.author.role !== 'user' ? `<span style="font-size:9px;padding:1px 6px;background:var(--gold-dim);color:var(--gold);border-radius:3px">${p.author.role.toUpperCase()}</span>` : ''}
            <span style="font-size:11px;color:var(--text3)">${createdDate}</span>
            ${isPinned}${isLocked}
          </div>
          <h3 style="font-size:15px;font-weight:700;margin-bottom:6px;color:var(--text)">${escapeHtml(p.title)}</h3>
          <p style="font-size:12px;color:var(--text2);line-height:1.5;max-height:80px;overflow:hidden;text-overflow:ellipsis">${formatSocialPreview(p.content)}</p>
          <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:var(--text3)">
            <span>${_sv.heart} ${p.like_count || 0}</span>
            <span>${ic.comment} ${p.comment_count || 0}</span>
          </div>
        </div>
        ${isAdmin ? `<div style="display:flex;gap:4px;flex-direction:column">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();togglePinPost(${p.id})" title="Pin">${p.is_pinned ? ic.pin : '○'}</button>
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();toggleLockPost(${p.id})" title="Lock">${p.is_locked ? ic.lock : '○'}</button>
          ${isOwner ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteSocialPost(${p.id})" title="Delete">${ic.trash}</button>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── UPDATE PAGINATION ───
function updateSocialPagination(total, page) {
  const paginationDiv = document.getElementById('social-pagination');
  if (total <= 20) {
    paginationDiv.style.display = 'none';
    return;
  }
  
  const maxPage = Math.ceil(total / 20);
  document.getElementById('social-page-info').textContent = `Página ${page} de ${maxPage}`;
  paginationDiv.style.display = 'flex';
}

// ─── OPEN POST DETAIL ───
async function openSocialPost(postId) {
  try {
    const post = await GET(`social/posts/${postId}`);
    openPostId = postId;
    
    const detailDiv = document.getElementById('social-post-detail');
    const isOwner = CU && String(CU.id) === String(post.author_id);
    const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
    
    const authorName = post.author ? escapeHtml(post.author.nick || post.author.name || 'Anônimo') : 'Anônimo';
  const authorRole = post.author && post.author.role !== 'user' ? escapeHtml(post.author.role) : '';
  const detailPhoto = post.author && post.author.photo ? `<img src="${post.author.photo}" alt="${authorName}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">` : `<span style="font-size:32px;display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:var(--s3)">${post.author ? (post.author.avatar || '🦁') : '🦁'}</span>`;
    detailDiv.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px">
        <div style="flex-shrink:0">${detailPhoto}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="font-weight:600;font-size:14px">${authorName}</span>
            ${authorRole ? `<span style="font-size:10px;padding:2px 8px;background:var(--gold-dim);color:var(--gold);border-radius:3px;text-transform:uppercase">${authorRole}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text3)">${new Date(post.created_at).toLocaleDateString('pt-BR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        ${isOwner || isAdmin ? `<div style="display:flex;gap:4px">
          ${isOwner ? `<button class="btn btn-ghost btn-sm" onclick="editSocialPost(${postId})">${ic.edit}</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteSocialPost(${postId})">${ic.trash}</button>` : ''}
        </div>` : ''}
      </div>
      <h2 style="font-family:'Playfair Display',serif;font-size:22px;font-weight:700;margin-bottom:12px">${post.title}</h2>
      <div style="font-size:13px;line-height:1.8;color:var(--text2);margin-bottom:16px;word-wrap:break-word">${formatSocialText(post.content)}</div>
      <div style="display:flex;gap:16px;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" onclick="toggleLikeSocialPost(${postId})" ${!CU ? 'disabled' : ''} style="gap:4px">
          ${post.liked_by_me ? _sv.heart : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`} ${post.like_count || 0}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="showCommentArea()" ${!CU ? 'disabled' : ''}>${ic.comment} Comentar</button>
      </div>
    `;
    
    document.getElementById('social-comment-input-area').style.display = CU ? '' : 'none';
    loadSocialComments(postId);
    
    document.getElementById('social-post-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    const newHash = `#/social${currentSocialType === 'update' ? '/updates' : ''}/post/${postId}`;
    history.replaceState(null, '', newHash);
    return true;
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
    return false;
  }
}

// ─── LOAD COMMENTS ───
async function loadSocialComments(postId) {
  try {
    const { comments } = await GET(`social/posts/${postId}/comments?limit=50`);
    renderSocialComments(comments);
  } catch (e) {
    document.getElementById('social-comments-list').innerHTML = `<p style="color:var(--red2);font-size:11px">${e.message}</p>`;
  }
}

// ─── RENDER COMMENTS ───
function renderSocialComments(comments) {
  const list = document.getElementById('social-comments-list');
  if (!comments.length) {
    list.innerHTML = '<p class="page-hint" style="margin:0">Nenhum comentário ainda.</p>';
    return;
  }
  
  list.innerHTML = comments.map(c => renderCommentThread(c, 0)).join('');
}

// ─── RENDER COMMENT THREAD ───
function renderCommentThread(comment, depth = 0) {
  const isOwner = CU && String(CU.id) === String(comment.author_id);
  const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
  const margin = depth > 0 ? `margin-left:${depth * 16}px` : '';
  const createdDate = new Date(comment.created_at).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  let html = `<div style="${margin};padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)">
    <div style="display:flex;gap:8px">
      <span style="font-size:16px;flex-shrink:0">${comment.author ? (comment.author.avatar || '🦁') : '🦁'}</span>
      <div style="flex:1">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">
          <strong>${comment.author ? comment.author.nick || comment.author.name : 'Anônimo'}</strong> · ${createdDate}
        </div>
        <div style="font-size:12px;line-height:1.6;margin-bottom:6px">${formatSocialText(comment.content)}</div>
        <div style="display:flex;gap:8px;font-size:11px">
          <button class="btn btn-ghost btn-sm" onclick="toggleLikeSocialComment(${comment.id})" ${!CU ? 'disabled' : ''} style="gap:4px">
            ${comment.liked_by_me ? _sv.heart : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`} ${comment.like_count || 0}
          </button>
          ${isOwner || isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="deleteSocialComment(${comment.id})">${ic.trash}</button>` : ''}
        </div>
      </div>
    </div>
  </div>`;
  
  if (comment.replies && comment.replies.length) {
    html += comment.replies.map(r => renderCommentThread(r, depth + 1)).join('');
  }
  
  return html;
}

// ─── LIKE POST ───
async function toggleLikeSocialPost(postId) {
  return withActionLock(`likePost${postId}`, async () => {
    try {
      if (openPostId === postId) {
        const post = await GET(`social/posts/${postId}`);
        if (post.liked_by_me) {
          await DEL(`social/posts/${postId}/like`);
        } else {
          await POST(`social/posts/${postId}/like`);
        }
        openSocialPost(postId);
      }
    } catch (e) {
      showMsg('social-post-detail', e.message, 'err');
    }
  });
}

// ─── LIKE COMMENT ───
async function toggleLikeSocialComment(commentId) {
  return withActionLock(`likeComment${commentId}`, async () => {
    try {
      const post = await GET(`social/posts/${openPostId}`);
      const cmtLiked = post.comments && post.comments.find(c => c.id === commentId)?.liked_by_me;
      if (cmtLiked) {
        await DEL(`social/comments/${commentId}/like`);
      } else {
        await POST(`social/comments/${commentId}/like`);
      }
      loadSocialComments(openPostId);
    } catch (e) {
      showMsg('social-comments-list', e.message, 'err');
    }
  });
}

// ─── COMMENT FUNCTIONS ───
function showCommentArea() {
  document.getElementById('social-comment-input-area').style.display = '';
  document.getElementById('social-comment-text').focus();
}

function closeCommentArea() {
  document.getElementById('social-comment-input-area').style.display = 'none';
  document.getElementById('social-comment-text').value = '';
}

async function submitComment() {
  const contentInput = document.getElementById('social-comment-text');
  const content = contentInput.value.trim();
  if (!content) return showMsg('social-comment-text', 'Escreva um comentário', 'err');
  if (content.length > SOCIAL_COMMENT_CHAR_LIMIT) return showMsg('social-comment-text', `Máximo ${SOCIAL_COMMENT_CHAR_LIMIT} caracteres`, 'err');
  if (containsBadWords(content)) return showMsg('social-comment-text', 'Conteúdo não permitido', 'err');
  
  const btn = document.getElementById('social-comment-submit-btn');
  setBtnBusy(btn, true, 'Comentando…');
  try {
    await POST(`social/posts/${openPostId}/comments`, { content, parentCommentId: null });
    closeCommentArea();
    loadSocialComments(openPostId);
  } catch (e) {
    showMsg('social-comment-text', e.message, 'err');
  } finally {
    setBtnBusy(btn, false);
  }
}

// ─── PUBLISH POST ───
async function publishSocialPost() {
  const titleInput = document.getElementById('social-title-input');
  const contentInput = document.getElementById('social-content-input');
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  
  if (!title) return showMsg('social-title-input', 'Título é obrigatório', 'err');
  if (title.length > 200) return showMsg('social-title-input', 'Título deve ter até 200 caracteres', 'err');
  if (!content) return showMsg('social-content-input', 'Conteúdo é obrigatório', 'err');
  if (content.length > SOCIAL_POST_CHAR_LIMIT) return showMsg('social-content-input', `Máximo ${SOCIAL_POST_CHAR_LIMIT} caracteres`, 'err');
  if (containsBadWords(title) || containsBadWords(content)) return showMsg('social-content-input', 'Conteúdo não permitido', 'err');
  
  const btn = document.getElementById('social-publish-btn');
  setBtnBusy(btn, true, 'Publicando…');
  try {
    await POST('social/posts', { title, content, type: currentSocialType });
    titleInput.value = '';
    contentInput.value = '';
    closeSocialComposer();
    loadSocialPage(1);
    showMsg('social-posts-list', _sv.check+' Post publicado!', 'ok');
    // reset counter display
    updateComposeCharCount();
  } catch (e) {
    showMsg('social-content-input', e.message, 'err');
  } finally {
    setBtnBusy(btn, false);
  }
}

function closeSocialComposer() {
  const modal = document.getElementById('social-compose-modal');
  modal.style.display = 'none';
  document.body.style.overflow = '';
}

// ─── EDIT/DELETE POST ───
async function editSocialPost(postId) {
  alert('Edição de posts em desenvolvimento. Por favor, delete e recrie.');
}

async function deleteSocialPost(postId) {
  if (!confirm('Tem certeza? Esta ação não pode ser desfeita.')) return;
  try {
    await DEL(`social/posts/${postId}`);
    closeSocialModal();
    loadSocialPage(currentSocialPage);
    showMsg('social-posts-list', _sv.check+' Post deletado', 'ok');
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
  }
}

async function deleteSocialComment(commentId) {
  if (!confirm('Deletar comentário?')) return;
  try {
    await DEL(`social/comments/${commentId}`);
    loadSocialComments(openPostId);
  } catch (e) {
    showMsg('social-comments-list', e.message, 'err');
  }
}

async function togglePinPost(postId) {
  try {
    await POST(`social/posts/${postId}/pin`);
    loadSocialPage(currentSocialPage);
  } catch (e) {
    showMsg('social-posts-list', e.message, 'err');
  }
}

async function toggleLockPost(postId) {
  try {
    await POST(`social/posts/${postId}/lock`);
    openSocialPost(postId);
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
  }
}

// ─── MODAL CONTROL ───
function closeSocialModal() {
  document.getElementById('social-post-modal').style.display = 'none';
  document.body.style.overflow = '';
  openPostId = null;
  history.replaceState(null, '', currentSocialTab === 'updates' ? '#/social/updates' : '#/social');
}

// ─── NOTIFICATION FUNCTIONS ───
async function loadNotifications(forceRefresh = false) {
  if (notificationsLoaded && !forceRefresh) return;
  
  try {
    const { notifications } = await GET('notifications?limit=20');
    renderNotifications(notifications);
    notificationsLoaded = true;
    updateNotificationBadge();
  } catch (e) {
    console.error('Notification load error:', e);
  }
}

function renderNotifications(notifications) {
  const list = document.getElementById('notif-list');
  const empty = document.getElementById('notif-empty');
  
  if (!notifications.length) {
    list.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  
  list.style.display = 'flex';
  empty.style.display = 'none';
  list.innerHTML = notifications.map(n => `
    <div style="padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;background:${n.is_read ? 'transparent' : 'var(--gold-dim)'}" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background='${n.is_read ? 'transparent' : 'var(--gold-dim)'}'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600;margin-bottom:2px">${n.message}</div>
          <div style="font-size:10px;color:var(--text3)">${new Date(n.created_at).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteNotification(${n.id})" style="font-size:10px;padding:2px 6px">×</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openNotificationLink(${n.id})" style="width:100%;margin-top:6px;justify-content:center;font-size:10px">Ver</button>
    </div>
  `).join('');
}

async function updateNotificationBadge() {
  try {
    const { unread_count } = await GET('notifications/unread-count');
    const badge = document.getElementById('notif-badge');
    if (unread_count > 0) {
      badge.textContent = unread_count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    console.error('Badge update error:', e);
  }
}

async function toggleNotifMenu() {
  const menu = document.getElementById('notif-menu');
  const isOpen = menu.style.display !== 'none';
  
  if (!isOpen) {
    await loadNotifications(true);
  }
  
  menu.style.display = isOpen ? 'none' : 'flex';
}

async function markAllRead() {
  try {
    await POST('notifications/read-all');
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Mark all read error:', e);
  }
}

async function deleteNotification(notificationId) {
  try {
    await DEL(`notifications/${notificationId}`);
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Delete notification error:', e);
  }
}

async function openNotificationLink(notificationId) {
  try {
    // Mark as read
    await POST(`notifications/${notificationId}/read`);
    
    // Get the notification to find the link
    const { notifications } = await GET('notifications?limit=50');
    const notif = notifications.find(n => n.id === notificationId);
    
    if (!notif) return;
    
    // Navigate based on type
    if (notif.reference_type === 'update') {
      currentSocialType = 'update';
      currentSocialTab = 'updates';
      showPage('social');
      showSocialTab('updates');
      setTimeout(() => openSocialPost(notif.reference_id), 500);
    } else {
      currentSocialType = 'forum';
      currentSocialTab = 'forum';
      showPage('social');
      showSocialTab('forum');
      setTimeout(() => openSocialPost(notif.reference_id), 500);
    }
    
    document.getElementById('notif-menu').style.display = 'none';
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Open notification error:', e);
  }
}

// Close compose modal when clicking on backdrop
document.addEventListener('click', (e) => {
  const composeModal = document.getElementById('social-compose-modal');
  if (composeModal && composeModal.style.display === 'flex' && e.target === composeModal) {
    closeSocialComposer();
  }
});

// Close notif menu if clicking outside (capturing to run before other handlers)
document.addEventListener('click', (e) => {
  const notifMenu = document.getElementById('notif-menu');
  const notifBtn = document.getElementById('notif-btn');
  if (!notifMenu) return;
  const isOpen = notifMenu.style.display !== 'none' && notifMenu.style.display !== '';
  if (isOpen && !notifMenu.contains(e.target) && (!notifBtn || !notifBtn.contains(e.target))) {
    notifMenu.style.display = 'none';
  }
}, true);

// dblclick on notif button closes menu immediately (also supports toggling)
const _notifBtnAttach = () => {
  const nb = document.getElementById('notif-btn');
  if (!nb) return;
  nb.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    const menu = document.getElementById('notif-menu');
    if (!menu) return;
    if (menu.style.display !== 'none' && menu.style.display !== '') {
      menu.style.display = 'none';
    } else {
      toggleNotifMenu();
    }
  });
};
_notifBtnAttach();

// --- Compose char counter ---
function updateComposeCharCount() {
  const contentEl = document.getElementById('social-content-input');
  const countEl = document.getElementById('social-char-count');
  if (!countEl || !contentEl) return;
  const len = contentEl.value.length;
  countEl.textContent = `${len}/${SOCIAL_POST_CHAR_LIMIT}`;
  countEl.style.color = len > SOCIAL_POST_CHAR_LIMIT ? 'var(--red2)' : 'var(--text3)';
}

// Attach input listener if element exists
const _composeAttach = () => {
  const contentEl = document.getElementById('social-content-input');
  if (!contentEl) return;
  contentEl.removeEventListener('input', updateComposeCharCount);
  contentEl.addEventListener('input', updateComposeCharCount);
  updateComposeCharCount();
};
_composeAttach();

// (Removed duplicate outside-click handler; capture handler above handles closing)

// Close social modal on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('social-post-modal').style.display !== 'none') {
    closeSocialModal();
  }
});

// Update notification badge on app start
function initNotifications() {
  updateNotificationBadge();
  // Check for new notifications every 30 seconds
  setInterval(() => {
    if (!document.hidden) {
      updateNotificationBadge();
    }
  }, 30000);
}

// Call this after user logs in
const originalStartApp = startApp;
startApp = async function() {
  await originalStartApp.call(this);
  initNotifications();
};

