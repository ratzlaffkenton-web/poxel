/**
 * Legion SDK Integration for Poxel.io (Unity WebGL)
 *
 * Loaded ONLY when the page URL contains ?legionsdk=true (see index.html).
 * It runs alongside sdk.js: sdk.js owns the banner engine + window.SDK lifecycle,
 * this file WRAPS those lifecycle methods (calls both Legion AND the original) and
 * adds Legion auth / social / room-presence / loading bridges.
 *
 * ESC key, pointer lock, and menu handling are automatic via the Legion SDK.
 */

// fps game-server auth endpoint (mirrors cg_sdk.js which hardcodes usa-1.poxel.io)
const IS_PLAYTEST_LINK = window.location.href.includes('playtest');
const GAME_AUTH_URL = IS_PLAYTEST_LINK
    ? 'https://dev-usa-1.poxel.io/api/accounts/login/legion'
    : 'https://usa-1.poxel.io/api/accounts/login/legion';

// Cache the latest user data from onUserChanged for sync getters
let cachedLegionUser = null;

// Track if Unity is ready to receive events
let unityReady = false;
// undefined = no result stored yet, null = auth failed, object = auth succeeded
let pendingAuthResult = undefined;

// Auth state: use a promise so concurrent calls wait for the same result
let authPromise = null; // Promise<result> | null - the in-flight or completed auth
let lastAuthLegionId = null; // Track which Legion user we authenticated

// Create a promise that resolves when the Legion SDK is initialized
const legionSdkInitPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../sdk.bloxity.io/v1/legion-sdk.min.js';
    script.onload = () => {
        if (window.Legion && window.Legion.SDK) {
            // Initialize SDK (ESC key + pointer lock handling is automatic).
            // gameSlug identifies the game to the Legion portal (used for IAP catalog
            // lookups, which Poxel.io does not currently use).
            window.Legion.SDK.init({ gameSlug: 'poxel-io' });

            // Listen for user changes - this fires immediately with current state
            window.Legion.SDK.auth.onUserChanged((user) => {
                console.log('[LegionIntegration] onUserChanged:', user ? user.username : 'null',
                    user ? `(legionId: ${user._id})` : '');

                // Cache the fresh user data
                cachedLegionUser = user;

                if (user) {
                    // User is logged in - authenticate with game server
                    authenticateWithGameServer();
                } else {
                    // User logged out or not logged in
                    console.log('[LegionIntegration] No user - clearing session');
                    // Reset auth state so next login starts fresh
                    authPromise = null;
                    lastAuthLegionId = null;
                    sendAuthResultToUnity(null);
                }
            });

            // Listen for all player events from Legion SDK
            if (typeof window.Legion.SDK.player?.onEvent === 'function') {
                window.Legion.SDK.player.onEvent((event, data) => {
                    switch (event) {
                        case 'respawn_request':
                            notifyUnity('LegionListener', 'OnLegionRespawnRequested');
                            break;
                        case 'chat_message_sent':
                            notifyUnity('LegionListener', 'OnLegionChatMessageSent', data);
                            break;
                        case 'pointer_lock_changed':
                            notifyUnity('LegionListener', 'OnLegionPointerLockChanged', data ? 'true' : 'false');
                            break;
                        default:
                            console.warn(`[LegionIntegration] Unknown player event: ${event}`);
                    }
                });
            } else {
                console.error('[LegionIntegration] player.onEvent not available.');
            }

            // ============================================
            // Settings Listeners (string-based API)
            // ============================================

            // Volume setting (0-100 as string)
            window.Legion.SDK.settings.listen('master_volume', (volume) => {
                notifyUnity('LegionListener', 'OnLegionVolumeChanged', volume);
            });

            // Music volume setting (0-100 as string)
            window.Legion.SDK.settings.listen('music_volume', (volume) => {
                notifyUnity('LegionListener', 'OnLegionMusicVolumeChanged', volume);
            });

            // Graphics quality setting ("Low", "Medium", "High", "Ultra")
            window.Legion.SDK.settings.listen('graphics_quality', (quality) => {
                notifyUnity('LegionListener', 'OnLegionGraphicsQualityChanged', quality);
            });

            // Show FPS setting ("true" or "false")
            window.Legion.SDK.settings.listen('show_fps', (showFps) => {
                notifyUnity('LegionListener', 'OnLegionShowFpsChanged', showFps);
            });

            // Camera sensitivity setting (0.1-5.0 as string)
            window.Legion.SDK.settings.listen('camera_sensitivity', (sensitivity) => {
                notifyUnity('LegionListener', 'OnLegionCameraSensitivityChanged', sensitivity);
            });

            // NOTE: Avatar/cosmetic listeners are intentionally NOT registered for Poxel.io.

            console.log('[LegionIntegration] SDK initialized');
            resolve();
        } else {
            reject(new Error('Legion SDK failed to load'));
        }
    };
    script.onerror = reject;
    document.head.appendChild(script);
});

// ============================================
// Unity Bridge Helper
// ============================================

function notifyUnity(objectName, methodName, value = '') {
    if (typeof unityInstance !== 'undefined' && unityInstance !== null) {
        unityInstance.SendMessage(objectName, methodName, value);
    }
}

// Exposed for C# (SDKManager) to push all current Legion settings to Unity at startup.
window.legionTriggerAllSettings = function () {
    window.Legion?.SDK?.settings?.triggerAll?.();
};

// ============================================
// Game Server Authentication
// ============================================

/**
 * Validates that the auth result is from the Poxel.io game server, not raw Legion data.
 * Game server responses contain a legionId on the user object.
 */
function isValidGameServerResponse(result) {
    if (!result || !result.user) return false;

    // Game server format: has legionId
    if (result.user.legionId !== undefined) return true;

    // Raw Legion format (avatar.hatId style) and no legionId -> reject
    const hasRawLegionFormat = result.user.avatar &&
        result.user.avatar.hatId !== undefined &&
        result.user.legionId === undefined;
    if (hasRawLegionFormat) {
        console.error('[LegionIntegration] REJECTED: Received raw Legion format instead of game server response!',
            JSON.stringify(result.user).substring(0, 200));
        return false;
    }

    // Otherwise accept if we at least got an access token + user
    return !!result.accessToken;
}

async function authenticateWithGameServer() {
    const currentLegionId = cachedLegionUser?._id;

    // If we already have an auth in progress/completed for this user, wait for it
    if (authPromise && lastAuthLegionId === currentLegionId) {
        console.log('[LegionIntegration] Auth already in progress for this user, waiting...');
        return authPromise;
    }

    // Start new auth
    console.log('[LegionIntegration] Starting new auth for legionId:', currentLegionId);
    lastAuthLegionId = currentLegionId;

    authPromise = (async () => {
        try {
            await legionSdkInitPromise;
            const username = cachedLegionUser?.username || '';
            window.Legion.SDK.game.loadingStep(`Signing In as ${username}...`);
            console.log('[LegionIntegration] Authenticating with game server...');
            const result = await window.Legion.SDK.auth.authenticateWithServer(GAME_AUTH_URL);

            if (result && isValidGameServerResponse(result)) {
                console.log('[LegionIntegration] Auth successful (valid game server response)');
                window.Legion.SDK.game.loadingStep("Signed In! Finding Lobby...");
                sendAuthResultToUnity(result);
                return result;
            } else if (result) {
                console.error('[LegionIntegration] Auth returned invalid format, not sending to Unity');
                authPromise = null;
                lastAuthLegionId = null;
                return null;
            } else {
                console.log('[LegionIntegration] Auth returned null');
                authPromise = null;
                lastAuthLegionId = null;
                sendAuthResultToUnity(null);
                return null;
            }
        } catch (error) {
            console.error('[LegionIntegration] Auth failed:', error);
            authPromise = null;
            lastAuthLegionId = null;
            sendAuthResultToUnity(null);
            return null;
        }
    })();

    return authPromise;
}

/**
 * Send auth result to Unity - handles the case where Unity might not be ready yet
 */
function sendAuthResultToUnity(result) {
    if (unityReady) {
        if (result) {
            console.log('[LegionIntegration] sendAuthResultToUnity: OK. Sending AuthManager.ProcessJsonAfterLogin');
            notifyUnity('AuthManager', 'ProcessJsonAfterLogin', JSON.stringify(result));
        } else {
            console.error('[LegionIntegration] sendAuthResultToUnity: logged out! Sending Logout2.');
            notifyUnity('AuthManager', 'Logout2');
            notifyUnity('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
        }
    } else {
        // Unity not ready yet - store for when it signals ready
        console.log('[LegionIntegration] Unity not ready, storing auth result');
        pendingAuthResult = result;
    }
}

/**
 * Called by Unity when it's ready to receive auth events.
 */
window.onUnityReady = function () {
    console.log('[LegionIntegration] Unity signaled ready');
    unityReady = true;

    // If we already have a stored result (success OR failure), send it now
    if (pendingAuthResult !== undefined) {
        console.log('[LegionIntegration] Sending pending auth result to Unity:', pendingAuthResult ? 'success' : 'failed');
        sendAuthResultToUnity(pendingAuthResult);
        pendingAuthResult = undefined;
    } else if (authPromise === null && cachedLegionUser === null) {
        // No pending result and no user - tell Unity there's no auto-login
        notifyUnity('AuthManager', 'SetAutoLoginPendingFromJS', 'false');
    }
};

// ============================================
// Unity Entry Points (called from Unity C#)
// ============================================

// Show auth modal (for games embedded in bloxity.io/g/[game])
window.showLegionAuthModal = async function () {
    await legionSdkInitPromise;
    if (window.Legion.SDK.auth.isLoggedIn()) {
        console.log('[LegionIntegration] Already logged into Legion, retrying game server auth');
        notifyUnity('AuthManager', 'SetAutoLoginPendingFromJS', 'true');
        authPromise = null;
        lastAuthLegionId = null;
        await authenticateWithGameServer();
        return;
    }
    await window.Legion.SDK.auth.showAuthModal();
};

// Show auth window (for standalone games on your own domain)
window.showLegionAuthWindow = async function () {
    await legionSdkInitPromise;
    if (window.Legion.SDK.auth.isLoggedIn()) {
        console.log('[LegionIntegration] Already logged into Legion, retrying game server auth');
        notifyUnity('AuthManager', 'SetAutoLoginPendingFromJS', 'true');
        authPromise = null;
        lastAuthLegionId = null;
        await authenticateWithGameServer();
        return;
    }
    await window.Legion.SDK.auth.showAuthWindow();
};

// Logout.
// GUARD: only log out if actually logged in. Otherwise a "no user" notification
// (onUserChanged(null) -> AuthManager.Logout2 -> ClearTokens -> logoutLegion) would call
// Legion.SDK.auth.logout(), which re-fires onUserChanged(null) -> infinite loop / stack overflow.
let legionLogoutInProgress = false;
window.logoutLegion = async function () {
    await legionSdkInitPromise;
    if (legionLogoutInProgress) return;
    if (typeof window.Legion.SDK.auth.isLoggedIn === 'function' && !window.Legion.SDK.auth.isLoggedIn()) return;
    try {
        legionLogoutInProgress = true;
        window.Legion.SDK.auth.logout();
    } finally {
        legionLogoutInProgress = false;
    }
};

// ============================================
// Room/Multiplayer Support
// ============================================

/**
 * Update the current room and party IDs for multiplayer presence.
 * @param {string} roomId  - game room/match ID, or '' if not in a match
 * @param {string} partyId - party ID, or '' if not in a party
 */
window.updateLegionRoom = async function (roomId, partyId) {
    await legionSdkInitPromise;
    window.Legion.SDK.game.updateRoom(roomId || '', partyId || '');
    console.log(`[LegionIntegration] Room updated: roomId=${roomId || '(none)'}, partyId=${partyId || '(none)'}`);
};

/** Report that a player just joined the current room (after you). */
window.legionPlayerJoined = async function (username) {
    await legionSdkInitPromise;
    window.Legion.SDK.game.playerJoined(username);
};

/** Report that a player was already in the room when you joined. */
window.legionPlayerInRoom = async function (username) {
    await legionSdkInitPromise;
    window.Legion.SDK.game.playerInRoom(username);
};

// ============================================
// Settings Getters (for one-time reads)
// ============================================

window.getLegionSetting = function (key) {
    if (!window.Legion || !window.Legion.SDK) return '';
    return window.Legion.SDK.settings.get(key) || '';
};

window.getLegionSettings = async function () {
    await legionSdkInitPromise;
    return window.Legion.SDK.settings.getAll();
};

// ============================================
// SDK Compatibility Layer (window.SDK.*)
// ============================================
// IMPORTANT: This wraps the existing sdk.js methods rather than replacing them.
// We call BOTH Legion's methods AND the original.

window.SDK = window.SDK || {};

function wrapLifecycleMethod(methodName, legionMethod) {
    const original = window.SDK[methodName];
    window.SDK[methodName] = async function (...args) {
        await legionSdkInitPromise;
        try { legionMethod(); } catch (e) { console.error('[LegionIntegration] lifecycle error', e); }
        if (typeof original === 'function') {
            return original.apply(this, args);
        }
    };
}

wrapLifecycleMethod('gameplayStart', () => window.Legion.SDK.game.gameplayStart());
wrapLifecycleMethod('loadingStart', () => window.Legion.SDK.game.loadingStep("Loading Started..."));
// For Legion we stay in LOADING state until the lobby is joined. When index.html/sdk.js
// calls loadingEnd (Unity WASM loaded), report a step instead of ending. The real
// loadingEnd happens via window.legionLoadingEnd() when the lobby is joined.
wrapLifecycleMethod('loadingEnd', () => window.Legion.SDK.game.loadingStep("Game Loaded! Signing in..."));
wrapLifecycleMethod('gameplayEnd', () => window.Legion.SDK.game.gameplayEnd());

// Exposed for C# (SDKManager.SDK_LegionLoadingStep) to report loading steps.
window.legionLoadingStep = async function (message) {
    await legionSdkInitPromise;
    window.Legion.SDK.game.loadingStep(message);
};

// Exposed for C# (SDKManager.SDK_LegionLoadingEnd) to signal loading is truly done.
window.legionLoadingEnd = async function () {
    await legionSdkInitPromise;
    window.Legion.SDK.game.loadingEnd();
    console.log('[LegionIntegration] loadingEnd called - lobby joined');
};

// Ad methods: DO NOT override if sdk.js already implemented them.
if (typeof window.SDK.showMidroll !== 'function') {
    window.SDK.showMidroll = function () {
        notifyUnity('SDKManager', 'OnVideoAdEnded', 'false');
    };
}
if (typeof window.SDK.showRewarded !== 'function') {
    window.SDK.showRewarded = function () {
        notifyUnity('SDKManager', 'OnVideoAdEnded', 'false');
    };
}
if (typeof window.SDK.SetBanner !== 'function') {
    window.SDK.SetBanner = function () { /* no-op fallback */ };
}

// ============================================
// Social/Connections API (friends)
// ============================================
// Entirely Legion-SDK-side. C# (FriendsManager) calls the *ForUnity wrappers
// and receives results via SendMessage('FriendsManager', ...).

window.getLegionConnections = async function () {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.getConnections();
};

window.fetchLegionConnectionsForUnity = async function () {
    try {
        const connections = await window.getLegionConnections();
        notifyUnity('FriendsManager', 'OnConnectionsReceived', JSON.stringify(connections));
    } catch (error) {
        console.error('[LegionIntegration] Failed to fetch connections:', error);
        notifyUnity('FriendsManager', 'OnConnectionsReceived', '[]');
    }
};

window.sendLegionConnectionRequest = async function (userId) {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.sendConnectionRequest(userId);
};

window.sendLegionConnectionRequestForUnity = async function (userId) {
    try {
        const result = await window.sendLegionConnectionRequest(userId);
        notifyUnity('FriendsManager', 'OnConnectionRequestSent', JSON.stringify(result));
    } catch (error) {
        console.error('[LegionIntegration] Failed to send connection request:', error);
        notifyUnity('FriendsManager', 'OnConnectionRequestSent', JSON.stringify({
            success: false,
            error: 'Network error'
        }));
    }
};

/**
 * Invite a friend to your current game/room.
 * Relies on updateLegionRoom() presence having been pushed by LegionListener.
 */
window.inviteLegionFriend = async function (friendId) {
    await legionSdkInitPromise;
    return window.Legion.SDK.social.inviteFriend(friendId);
};

window.inviteLegionFriendForUnity = async function (friendId) {
    try {
        const success = await window.inviteLegionFriend(friendId);
        notifyUnity('FriendsManager', 'OnInviteSent', success ? 'true' : 'false');
    } catch (error) {
        console.error('[LegionIntegration] Failed to send invite:', error);
        notifyUnity('FriendsManager', 'OnInviteSent', 'false');
    }
};

/**
 * Get a shareable "invite friends" link for the player's CURRENT room/party presence
 * (the presence LegionListener reports via updateLegionRoom). Synchronous; returns '' if the
 * SDK isn't ready yet. Called from C# via WebUtils.GetWindowProperty("getLegionInviteLink()"),
 * which evaluates this expression and marshals the returned string back to Unity.
 */
window.getLegionInviteLink = function () {
    try {
        if (window.Legion && window.Legion.SDK && window.Legion.SDK.social &&
            typeof window.Legion.SDK.social.getInviteFriendsLink === 'function') {
            return window.Legion.SDK.social.getInviteFriendsLink() || '';
        }
    } catch (e) {
        console.error('[LegionIntegration] getInviteFriendsLink failed:', e);
    }
    return '';
};

// NOTE: IAP/Bux purchase bridge intentionally omitted for Poxel.io.
