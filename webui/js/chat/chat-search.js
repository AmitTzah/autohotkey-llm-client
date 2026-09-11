// ======================================================
// chat-search.js — Real-time message search with dropdown
//
// Wires the two search inputs (global "Search chats..." and
// scoped "Search in chat...") with debounced queries to AHK,
// dropdown results with term highlighting, keyboard nav,
// and click-to-navigate reusing existing scrollToMessage.
// ======================================================

var _activeQueryId = 0;
var _debounceTimer = null;
var _searchDropdownEl = null;
var _selectedIndex = -1;
var _searchTimeout = null;
var _activeSearchWrapper = null;  // the .search-wrap that owns the open dropdown
var _pendingSearchScrollMsgId = null;  // message to scroll to after initChatMode (tree pattern)
var _pendingSearchScrollThreadId = null;  // thread that owns the pending search result

// Initialize search inputs — called from main.js DOMContentLoaded
function initSearch() {
    var globalInput = document.querySelector('.search-wrap:not(.in-panel) .search-input');
    var scopedInput = document.querySelector('.search-wrap.in-panel .search-input');

    if (globalInput) {
        globalInput.addEventListener('input', function(e) { handleSearchInput(e, false); });
        globalInput.addEventListener('keydown', handleSearchKeydown);
        globalInput.addEventListener('focus', function() { if (globalInput.value.length >= 2) triggerSearch(globalInput, false); });
    }

    if (scopedInput) {
        scopedInput.addEventListener('input', function(e) { handleSearchInput(e, true); });
        scopedInput.addEventListener('keydown', handleSearchKeydown);
        scopedInput.addEventListener('focus', function() { if (scopedInput.value.length >= 2) triggerSearch(scopedInput, true); });
        updateScopedSearchState();
    }
}

// Enable/disable the scoped (right-panel) search based on active thread
function updateScopedSearchState() {
    var scopedInput = document.querySelector('.search-wrap.in-panel .search-input');
    if (!scopedInput) return;
    if (!activeThreadId) {
        scopedInput.disabled = true;
        scopedInput.placeholder = 'Open a chat to search';
    } else {
        scopedInput.disabled = false;
        scopedInput.placeholder = 'Search in chat...';
    }
}

// Debounced input handler
function handleSearchInput(e, isScoped) {
    var input = e.target;
    var query = (input.value || '').trim();

    clearTimeout(_debounceTimer);
    clearTimeout(_searchTimeout);
    _debounceTimer = null;
    _searchTimeout = null;

    if (query.length < 2) {
        closeSearchDropdown();
        return;
    }

    _debounceTimer = setTimeout(function() {
        triggerSearch(input, isScoped);
    }, 250);
}

// Fire the search
function triggerSearch(input, isScoped) {
    var query = (input.value || '').trim();
    if (query.length < 2) return;

    _activeQueryId++;
    var queryId = _activeQueryId;
    _activeSearchWrapper = input.closest('.search-wrap');

    var payload = { query: query, queryId: queryId };
    if (isScoped && activeThreadId) {
        payload.threadId = activeThreadId;
    }

  Ipc.postToHost('searchMessages', payload);

    // 10-second timeout
    _searchTimeout = setTimeout(function() {
        if (_activeQueryId === queryId) {
            renderSearchDropdown(_activeSearchWrapper, [], query, 'timeout');
        }
    }, 10000);

    // Show loading state immediately
    showSearchLoading();
}

function showSearchLoading() {
    if (!_activeSearchWrapper) return;
    if (!_searchDropdownEl) {
        _searchDropdownEl = createDropdownElement(_activeSearchWrapper);
    }
    _searchDropdownEl.innerHTML = '<div class="search-loading">Searching...</div>';
    _searchDropdownEl.style.display = 'block';
}

// Called from main.js when AHK responds
function handleSearchResults(data) {
    // Stale response guard
    if (data.queryId !== _activeQueryId) return;

    clearTimeout(_searchTimeout);
    _searchTimeout = null;

    var wrapper = _activeSearchWrapper;
    if (!wrapper) return;

    renderSearchDropdown(wrapper, data.results || [], data.query || '', 'results');
}

function renderSearchDropdown(wrapper, results, query, mode) {
    if (!_searchDropdownEl || _searchDropdownEl.parentNode !== wrapper) {
        if (_searchDropdownEl && _searchDropdownEl.parentNode) {
            _searchDropdownEl.parentNode.removeChild(_searchDropdownEl);
        }
        _searchDropdownEl = createDropdownElement(wrapper);
    }

    _selectedIndex = -1;

    if (mode === 'timeout') {
        _searchDropdownEl.innerHTML = '<div class="search-loading">Search timed out</div>';
        _searchDropdownEl.style.display = 'block';
        return;
    }

    if (results.length === 0) {
        _searchDropdownEl.innerHTML = '<div class="search-empty">No messages found</div>';
        _searchDropdownEl.style.display = 'block';
        return;
    }

    // Sort: active thread results first, then by createdAt descending
    results.sort(function(a, b) {
        var aActive = a.threadId === activeThreadId ? 0 : 1;
        var bActive = b.threadId === activeThreadId ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    var html = '';
    for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var isTitleOnly = !r.messageId && r.role === 'system';

        html += '<div class="search-result-item" data-index="' + i + '"';
        html += ' data-thread-id="' + escHtml(r.threadId || '') + '"';
        html += ' data-message-id="' + escHtml(r.messageId || '') + '"';
        html += '>';

        // Role label
        if (isTitleOnly) {
            html += '<div class="search-result-role">Chat</div>';
        } else if (r.role === 'user') {
            html += '<div class="search-result-role">You</div>';
        } else if (r.role === 'assistant') {
            html += '<div class="search-result-role">' + escHtml(r.model || 'Assistant') + '</div>';
        }

        // Thread title or content preview with highlighted term
        if (isTitleOnly) {
            html += '<div class="search-result-preview">' + highlightTerm(r.threadTitle, query) + '</div>';
        } else {
            if (r.threadTitle) {
                var label = r.threadId === activeThreadId ? 'Current Chat' : escHtml(r.threadTitle);
                var labelClass = r.threadId === activeThreadId ? ' search-result-thread-current' : '';
                html += '<div class="search-result-thread' + labelClass + '">' + label + '</div>';
            }
            if (r.contentPreview) {
                html += '<div class="search-result-preview">' + highlightTerm(r.contentPreview, query) + '</div>';
            }
        }

        html += '</div>';
    }

    _searchDropdownEl.innerHTML = html;
    _searchDropdownEl.style.display = 'block';

    // Attach click handlers
    var items = _searchDropdownEl.querySelectorAll('.search-result-item');
    for (var j = 0; j < items.length; j++) {
        items[j].addEventListener('click', function(e) {
            var idx = parseInt(this.getAttribute('data-index'));
            selectSearchResult(idx);
        });
    }
}

function selectSearchResult(index) {
    if (!_searchDropdownEl) return;
    var items = _searchDropdownEl.querySelectorAll('.search-result-item');
    if (index < 0 || index >= items.length) return;

    var item = items[index];
    var threadId = item.getAttribute('data-thread-id');
    var messageId = item.getAttribute('data-message-id');

    closeSearchDropdown();

    if (!messageId) {
        // Title-only result — just load the thread
        if (threadId && threadId !== activeThreadId) {
            Ipc.postToHost('sidebarAction', { subAction: 'loadThread', threadId: threadId });
        }
        return;
    }

    // Exact same pattern as tree modal (chat-branching.js:246-258):
    //   navigateToMessage + setTimeout(150) → scrollToMessageById
    if (threadId && threadId !== activeThreadId) {
        // Cross-thread: optimistic loadThread (sidebar click pattern), then navigate+scroll
        if (typeof loadThread === 'function') loadThread(threadId);
        _pendingSearchScrollMsgId = messageId;
        _pendingSearchScrollThreadId = threadId;
        Ipc.postToHost('sidebarAction', { subAction: 'loadThread', threadId: threadId });
        return;
    }

    // Same thread, off-path: navigateToMessage + scroll (tree pattern)
    Ipc.postToHost('sidebarAction', { subAction: 'navigateToMessage', messageId: messageId });
    setTimeout(function() { scrollToMessageById(messageId); }, 150);
}

// Called from initChatMode after cross-thread loadThread completes.
// Posts navigateToMessage + tree-pattern setTimeout scroll.
function onSearchCrossThreadLoaded() {
    if (!_pendingSearchScrollMsgId) return;
    // initChatMode runs on every thread load; consume pending navigation only for its thread.
    // pending navigation when the CURRENT thread is the one the search result
    // belongs to - otherwise an unrelated thread (or a failed load followed by
    // any other navigation) silently drops or misroutes the search scroll.
    if (_pendingSearchScrollThreadId && activeThreadId !== _pendingSearchScrollThreadId) return;
    var msgId = _pendingSearchScrollMsgId;
    _pendingSearchScrollMsgId = null;
    _pendingSearchScrollThreadId = null;
    Ipc.postToHost('sidebarAction', { subAction: 'navigateToMessage', messageId: msgId });
    setTimeout(function() { scrollToMessageById(msgId); }, 150);
}

// Highlight the search term in text (HTML-escaped first, then <mark>-wrapped)
function highlightTerm(text, term) {
    var safe = escHtml(text);
    if (!term || term.length < 2) return safe;
    var safeTerm = escHtml(term);
    // Case-insensitive replace
    var regex = new RegExp('(' + safeTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return safe.replace(regex, '<mark>$1</mark>');
}

// Create the dropdown DOM element
function createDropdownElement(wrapper) {
    var el = document.createElement('div');
    el.className = 'search-dropdown';
    wrapper.appendChild(el);
    return el;
}

function closeSearchDropdown() {
    // A response for the dismissed query may already be in flight.  Advance
    // the generation so it cannot recreate the dropdown after Escape, an
    // outside click, a scroll, or clearing the input below the minimum length.
    _activeQueryId++;
    clearTimeout(_debounceTimer);
    clearTimeout(_searchTimeout);
    _debounceTimer = null;
    _searchTimeout = null;
    if (_searchDropdownEl) {
        _searchDropdownEl.style.display = 'none';
    }
    _selectedIndex = -1;
}

// Keyboard navigation
function handleSearchKeydown(e) {
    if (!_searchDropdownEl || _searchDropdownEl.style.display === 'none') {
        return;
    }

    var items = _searchDropdownEl.querySelectorAll('.search-result-item');

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            _selectedIndex = Math.min(_selectedIndex + 1, items.length - 1);
            updateKeyboardHighlight(items);
            break;
        case 'ArrowUp':
            e.preventDefault();
            _selectedIndex = Math.max(_selectedIndex - 1, -1);
            updateKeyboardHighlight(items);
            break;
        case 'Enter':
            e.preventDefault();
            if (_selectedIndex >= 0 && _selectedIndex < items.length) {
                selectSearchResult(_selectedIndex);
            }
            break;
        case 'Escape':
            e.preventDefault();
            e.stopPropagation();  // prevent document handler from posting hideWindow
            closeSearchDropdown();
            break;
    }
}

function updateKeyboardHighlight(items) {
    for (var i = 0; i < items.length; i++) {
        if (i === _selectedIndex) {
            items[i].classList.add('active');
        } else {
            items[i].classList.remove('active');
        }
    }
}

// Click-outside handler — set up once at document level
document.addEventListener('click', function(e) {
    if (_searchDropdownEl && _searchDropdownEl.style.display !== 'none') {
        var insideSearch = e.target.closest('.search-wrap');
        if (!insideSearch) {
            closeSearchDropdown();
        }
    }
});

// Close dropdown when containing panel scrolls
document.addEventListener('DOMContentLoaded', function() {
    var leftScroll = document.querySelector('.rail-left-scroll');
    var rightPanel = document.querySelector('.rail-right');
    if (leftScroll) leftScroll.addEventListener('scroll', closeSearchDropdown);
    if (rightPanel) rightPanel.addEventListener('scroll', closeSearchDropdown);
});


if (typeof window !== 'undefined') window.ChatSearch = {
  init: initSearch
};
