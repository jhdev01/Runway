// Runway Remote — slice 2: preview + PIN-gated controls.
// State flow:
//   - WS receives `state` snapshots with an `unlocked` flag per-client.
//   - "Hold to unlock" runs a 1.5s gesture; on completion the PIN overlay
//     opens. Successful PIN sends an `unlock` message; the server responds
//     with `auth-result` and starts pushing snapshots with unlocked: true.
//   - Action buttons send `cmd` messages. Server forwards into the
//     renderer's controller; auto-relock kicks in after the configured
//     idle window if the user doesn't keep tapping.

(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    serviceName: $('serviceName'),
    serviceStatus: $('serviceStatus'),
    timerWrap: $('timerWrap'),
    timerLabel: $('timerLabel'),
    timer: $('timer'),
    timerMeta: $('timerMeta'),
    nowPlayingWrap: $('nowPlayingWrap'),
    npTitle: $('npTitle'),
    npArt: $('npArt'),
    npArtPlaceholder: $('npArtPlaceholder'),
    npPos: $('npPos'),
    npNextWrap: $('npNextWrap'),
    npNext: $('npNext'),
    lightMidi: $('lightMidi'),
    lightPp: $('lightPp'),
    lightAudio: $('lightAudio'),
    hdrTime: $('hdrTime'),
    conn: $('conn'),
    lockBar: $('lockBar'),
    swipeTrack: $('swipeTrack'),
    swipeThumb: $('swipeThumb'),
    swipeFill: $('swipeFill'),
    swipeText: $('swipeText'),
    actionBar: $('actionBar'),
    hdrLockBtn: $('hdrLockBtn'),
    armBtn: $('armBtn'),
    armLabel: $('armLabel'),
    armIcon: $('armIcon'),
    padBtn: $('padBtn'),
    padLabel: $('padLabel'),
    pinOverlay: $('pinOverlay'),
    pinDots: $('pinDots'),
    pinError: $('pinError'),
    midiMonitor: $('midiMonitor'),
    midiRecent: $('midiRecent'),
    midiViewAll: $('midiViewAll'),
    midiClear: $('midiClear'),
    midiOverlay: $('midiOverlay'),
    midiAll: $('midiAll'),
    midiClose: $('midiClose'),
    midiClearOverlay: $('midiClearOverlay'),
    masterVolRow: document.querySelector('.master-vol-row'),
    masterVolSlider: $('masterVolSlider'),
    masterVolPct: $('masterVolPct'),
    masterMuteBtn: $('masterMuteBtn'),
    postServiceBtn: $('postServiceBtn'),
    postTransport: $('postTransport'),
    padArmedKeyChip: $('padArmedKeyChip'),
    padKeyPickBtn: $('padKeyPickBtn'),
    padKeyOverlay: $('padKeyOverlay'),
    padKeyClose: $('padKeyClose'),
    padKeyGrid: $('padKeyGrid'),
    fadeToPadBtn: $('fadeToPadBtn'),
    fadeToPadIcon: $('fadeToPadIcon'),
    fadeToPadLabel: $('fadeToPadLabel'),
    miniActions: $('miniActions'),
    stopAllBtn: $('stopAllBtn'),
    stopAllLabel: $('stopAllLabel'),
    forgetPinBtn: $('forgetPinBtn'),
  };

  let snapshot = null;
  let lastSnapshotAt = 0;
  let unlocked = false;

  // ---- Saved PIN ----
  // Once a PIN successfully unlocks, stash it in localStorage so the user
  // doesn't have to re-enter on every reconnect / page load. A swipe will
  // auto-submit the saved PIN; if the server rejects it (PIN was changed
  // on the desktop) we clear it and fall back to the keypad.
  const PIN_KEY = 'runway-remote-pin';
  const savedPin = () => {
    try { return localStorage.getItem(PIN_KEY); } catch { return null; }
  };
  const savePin = (pin) => {
    try { localStorage.setItem(PIN_KEY, pin); } catch {}
  };
  const clearSavedPin = () => {
    try { localStorage.removeItem(PIN_KEY); } catch {}
    refreshForgetPinBtn();
  };
  // Show/hide the "Forget saved PIN" link based on whether there's
  // actually anything to forget. Hidden when locked-out by lockout.
  function refreshForgetPinBtn() {
    if (!els.forgetPinBtn) return;
    els.forgetPinBtn.hidden = !savedPin();
  }
  // Track whether the last unlock attempt came from the saved PIN — if
  // it fails, we know to clear and prompt the user manually.
  let autoSubmittedPin = false;
  let lastSubmittedPin = '';

  // ---- WebSocket ----
  let ws = null;
  let reconnectTimer = null;
  function setConn(state, text) {
    els.conn.className = 'hdr-conn ' + state;
    els.conn.textContent = text;
    // Only hide the pill when fully live. Showing "connecting…" /
    // "reconnecting…" surfaces transient state so the operator can
    // tell whether the page just hasn't shaken hands yet vs the
    // server actually being unreachable.
    els.conn.hidden = state === 'live';
  }
  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
  let connectAttempt = 0;
  function connect() {
    // Tear down any stale socket from a previous attempt before
    // opening a new one. iOS Safari sometimes still surfaces
    // close/error events from the old socket after we've moved on,
    // which used to cascade into spurious 'lost' state flips.
    if (ws) {
      try { ws.close(); } catch {}
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws = null;
    }
    connectAttempt++;
    setConn('connecting', 'connecting…');
    const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
    let thisWs;
    try { thisWs = new WebSocket(url); }
    catch { scheduleReconnect(); return; }
    ws = thisWs;
    // Guard every listener: only act on events from the *current* ws.
    // Without this, a late event from a stale socket can flip state
    // back to 'lost' even though a newer connection is already live.
    thisWs.onopen = () => {
      if (ws !== thisWs) return;
      connectAttempt = 0;
      setConn('live', 'live');
    };
    thisWs.onmessage = (e) => {
      if (ws !== thisWs) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'state') {
        snapshot = msg.payload;
        lastSnapshotAt = Date.now();
        applyUnlocked(!!snapshot.unlocked);
      } else if (msg.type === 'auth-result') {
        applyUnlocked(!!msg.payload?.unlocked);
        if (msg.payload?.unlocked) {
          // Successful unlock — persist this PIN so future swipes skip
          // the keypad. lastSubmittedPin is set from either auto-submit
          // (the stored value) or from the keypad submit.
          if (lastSubmittedPin) savePin(lastSubmittedPin);
          autoSubmittedPin = false;
          closePinOverlay();
        } else if (msg.payload?.error) {
          if (autoSubmittedPin) {
            // The stored PIN was rejected (admin changed it). Clear it
            // and surface the keypad so the user can re-enter.
            clearSavedPin();
            autoSubmittedPin = false;
            openPinOverlay();
            showPinError('PIN changed — please re-enter.');
          } else {
            showPinError(msg.payload.error);
          }
        }
      }
    };
    thisWs.onclose = () => {
      if (ws !== thisWs) return;
      setConn('lost', 'reconnecting…');
      scheduleReconnect();
    };
    // Don't auto-close on error — onclose will fire if the socket
    // really died, and forcing close here can stomp a connection
    // that iOS Safari was about to recover on its own.
    thisWs.onerror = () => {
      if (ws !== thisWs) return;
      // No-op — let onclose drive the state machine.
    };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    // Quick first retry (500 ms) so the typical case of "page loaded
    // before the WS handshake settled" recovers immediately. Subsequent
    // attempts back off to 2 s so a truly down server doesn't hammer.
    const delay = connectAttempt <= 1 ? 500 : 2000;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  }

  // ---- Lock state UI ----
  function applyUnlocked(next) {
    // Always reflect locked/unlocked on the body class — the CSS uses
    // it to drive the locked-only large-album-art layout, and the
    // initial paint needs it set even when state hasn't changed yet.
    document.body.classList.toggle('locked-view', !next);
    if (unlocked === next) return;
    unlocked = next;
    if (unlocked) {
      els.lockBar.hidden = true;
      els.actionBar.hidden = false;
      if (els.hdrLockBtn) els.hdrLockBtn.hidden = false;
    } else {
      els.lockBar.hidden = false;
      els.actionBar.hidden = true;
      if (els.hdrLockBtn) els.hdrLockBtn.hidden = true;
      // Reset swipe thumb + re-evaluate forget-pin button visibility
      resetSwipe(true);
      refreshForgetPinBtn();
    }
  }

  // ---- Swipe-to-unlock gesture ----
  const SWIPE_COMPLETE_PCT = 0.92; // 92% of the travel triggers unlock
  let swipeDragging = false;
  let swipeStartX = 0;
  let swipeOffset = 0;
  let swipeMaxX = 0; // recomputed on each pointerdown to handle resize

  function resetSwipe(animate) {
    swipeDragging = false;
    swipeOffset = 0;
    els.swipeThumb.classList.remove('dragging', 'complete');
    if (animate) {
      els.swipeThumb.style.transform = 'translateX(0)';
    } else {
      els.swipeThumb.style.transition = 'none';
      els.swipeThumb.style.transform = 'translateX(0)';
      // Force reflow then re-enable transition for next time.
      void els.swipeThumb.offsetWidth;
      els.swipeThumb.style.transition = '';
    }
    els.swipeFill.style.width = '0%';
    els.swipeText.style.opacity = '1';
  }

  function computeMaxX() {
    const trackW = els.swipeTrack.clientWidth;
    const thumbW = els.swipeThumb.clientWidth;
    // 4px padding on each side (matches CSS top:4px / left:4px).
    return Math.max(0, trackW - thumbW - 8);
  }

  function onSwipeStart(ev) {
    ev.preventDefault();
    swipeDragging = true;
    swipeStartX = ev.clientX;
    swipeMaxX = computeMaxX();
    els.swipeThumb.classList.add('dragging');
    try { els.swipeThumb.setPointerCapture(ev.pointerId); } catch {}
  }

  function onSwipeMove(ev) {
    if (!swipeDragging) return;
    const dx = ev.clientX - swipeStartX;
    swipeOffset = Math.max(0, Math.min(swipeMaxX, dx));
    els.swipeThumb.style.transform = `translateX(${swipeOffset}px)`;
    const pct = swipeMaxX > 0 ? swipeOffset / swipeMaxX : 0;
    els.swipeFill.style.width = (pct * 100) + '%';
    // Fade the "Swipe to unlock" text out as we approach completion so
    // the gesture feels like the thumb is "covering" the label.
    els.swipeText.style.opacity = String(Math.max(0, 1 - pct * 1.6));
  }

  function onSwipeEnd(ev) {
    if (!swipeDragging) return;
    swipeDragging = false;
    els.swipeThumb.classList.remove('dragging');
    try { els.swipeThumb.releasePointerCapture(ev.pointerId); } catch {}
    const pct = swipeMaxX > 0 ? swipeOffset / swipeMaxX : 0;
    if (pct >= SWIPE_COMPLETE_PCT) {
      // Snap to end. If we have a saved PIN, auto-submit it silently;
      // otherwise show the keypad.
      els.swipeThumb.style.transform = `translateX(${swipeMaxX}px)`;
      els.swipeThumb.classList.add('complete');
      els.swipeFill.style.width = '100%';
      els.swipeText.style.opacity = '0';
      const stored = savedPin();
      if (stored && stored.length === 4) {
        autoSubmittedPin = true;
        lastSubmittedPin = stored;
        send({ type: 'unlock', pin: stored });
      } else {
        openPinOverlay();
      }
      // Reset shortly after so the thumb glides back if the unlock fails
      // or the user cancels — gives them another swipe to retry.
      setTimeout(() => { if (!unlocked) resetSwipe(true); }, 350);
    } else {
      // Animate back to start.
      resetSwipe(true);
    }
  }

  els.swipeThumb.addEventListener('pointerdown', onSwipeStart);
  els.swipeThumb.addEventListener('pointermove', onSwipeMove);
  els.swipeThumb.addEventListener('pointerup', onSwipeEnd);

  // Press-and-hold unlock — same end behaviour as the old swipe (saved
  // PIN auto-submits, otherwise keypad opens) but the gesture is just
  // press your thumb on the button for HOLD_MS. The progress fill
  // animates over the hold; releasing early snaps the fill back and
  // cancels the unlock.
  const wideUnlockBtn = document.getElementById('wideUnlockBtn');
  const wideUnlockFill = document.getElementById('wideUnlockFill');
  const wideUnlockLabel = document.getElementById('wideUnlockLabel');
  // Generate the audio-meter bars. Each rect gets:
  //   --delay   when its grow phase starts (staggered by x so the
  //             "grow" wave ripples left-to-right across the row in
  //             step with HOLD_MS).
  //   --bob-dur how long one oscillation cycle takes after the bar is
  //             fully grown. Varied per-bar so the bars drift out of
  //             phase and look like independent audio levels rather
  //             than a synchronized march.
  const wideUnlockBars = document.getElementById('wideUnlockBars');
  if (wideUnlockBars) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HEIGHTS = [40, 18, 52, 28, 10, 46, 22, 38, 14, 50, 32, 8, 44, 20, 56, 24, 36, 12, 48, 30];
    const BOB_DURS = [520, 740, 880, 610, 950, 690, 1100, 580, 820, 990, 660, 870, 540, 940, 720, 850, 600, 780, 1020, 700];
    const BAR_W = 3;
    const STEP = 5;
    const VIEW_W = 400;
    // Bar-grow ≈ 120ms; leave HOLD_MS - 120 for the stagger so the
    // rightmost bar finishes growing right around when unlock fires.
    const STAGGER_MS = 280;
    for (let x = 0; x < VIEW_W; x += STEP) {
      const idx = (x / STEP) % HEIGHTS.length;
      const h = HEIGHTS[idx];
      const bobDur = BOB_DURS[idx];
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String((60 - h) / 2));
      r.setAttribute('width', String(BAR_W));
      r.setAttribute('height', String(h));
      r.setAttribute('rx', '1.5');
      r.setAttribute('ry', '1.5');
      r.style.setProperty('--delay', `${(x / VIEW_W) * STAGGER_MS}ms`);
      r.style.setProperty('--bob-dur', `${bobDur}ms`);
      wideUnlockBars.appendChild(r);
    }
  }
  if (wideUnlockBtn) {
    const HOLD_MS = 400;
    let holdTimer = null;
    let holdActivePointerId = null;
    const beginHold = (ev) => {
      if (holdActivePointerId !== null) return;
      holdActivePointerId = ev.pointerId ?? 'mouse';
      try { ev.target.setPointerCapture?.(ev.pointerId); } catch {}
      // Adding .pressing triggers each bar's staggered scaleY(0→1)
      // transition (delays baked in when the bars were generated), so
      // the row visually "grows" left-to-right across the button while
      // the user holds.
      wideUnlockBtn.classList.add('pressing');
      if (wideUnlockLabel) wideUnlockLabel.textContent = 'Keep holding…';
      holdTimer = setTimeout(() => {
        wideUnlockBtn.classList.add('complete');
        if (wideUnlockLabel) wideUnlockLabel.textContent = 'Unlocking…';
        const stored = savedPin();
        if (stored && stored.length === 4) {
          autoSubmittedPin = true;
          lastSubmittedPin = stored;
          send({ type: 'unlock', pin: stored });
        } else {
          openPinOverlay();
        }
        holdTimer = null;
      }, HOLD_MS);
    };
    const cancelHold = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      holdActivePointerId = null;
      // Drop .pressing — bars revert to the base scaleY(0) state with
      // no transition-delay (the per-bar delays only apply on the way
      // up), so the whole row collapses simultaneously instead of
      // unwinding in reverse-stagger.
      wideUnlockBtn.classList.remove('pressing', 'complete');
      if (wideUnlockLabel) wideUnlockLabel.textContent = 'Hold to unlock';
    };
    wideUnlockBtn.addEventListener('pointerdown', beginHold);
    wideUnlockBtn.addEventListener('pointerup', cancelHold);
    wideUnlockBtn.addEventListener('pointercancel', cancelHold);
    wideUnlockBtn.addEventListener('pointerleave', cancelHold);
  }
  els.swipeThumb.addEventListener('pointercancel', onSwipeEnd);

  // ---- PIN entry ----
  let pinDigits = '';
  function openPinOverlay() {
    pinDigits = '';
    renderPinDots();
    showPinError('');
    els.pinOverlay.hidden = false;
  }
  function closePinOverlay() {
    pinDigits = '';
    renderPinDots();
    els.pinOverlay.hidden = true;
  }
  function renderPinDots() {
    const dots = els.pinDots.querySelectorAll('.pin-dot');
    dots.forEach((d, i) => {
      if (i < pinDigits.length) d.classList.add('filled');
      else d.classList.remove('filled');
    });
  }
  function showPinError(msg) {
    els.pinError.textContent = msg || '';
  }
  document.querySelectorAll('.pin-key').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.d;
      if (d === 'cancel') {
        closePinOverlay();
        return;
      }
      if (d === 'back') {
        pinDigits = pinDigits.slice(0, -1);
        renderPinDots();
        showPinError('');
        return;
      }
      if (pinDigits.length >= 4) return;
      pinDigits += d;
      renderPinDots();
      showPinError('');
      if (pinDigits.length === 4) {
        // Submit. Server replies with auth-result. Track the value so
        // we know what to persist if the unlock succeeds.
        lastSubmittedPin = pinDigits;
        autoSubmittedPin = false;
        send({ type: 'unlock', pin: pinDigits });
      }
    });
  });

  // ---- Action buttons (only meaningful while unlocked) ----
  // Stop All needs a two-tap confirm — accidental panics in front of a
  // live congregation are bad. First tap arms a 3-second confirm window
  // (button pulses red, label flips to "Tap to Confirm"); a second tap
  // within that window fires the actual panic.
  let stopConfirmTimer = null;
  const exitStopConfirm = () => {
    if (stopConfirmTimer) {
      clearTimeout(stopConfirmTimer);
      stopConfirmTimer = null;
    }
    if (els.stopAllBtn) {
      els.stopAllBtn.classList.remove('confirm-stop');
    }
    if (els.stopAllLabel) els.stopAllLabel.textContent = 'Stop All';
  };
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      // Inner controls (post-transport buttons, pad-key-pick chevron)
      // bubble up; ignore them here so the parent action button doesn't
      // also fire its command.
      const target = ev.target;
      if (target && target.closest && target.closest('.post-transport-btn, .pad-key-pick')) {
        return;
      }
      if (!unlocked) return;
      let cmd = btn.dataset.cmd;
      if (!cmd) return;
      // Pad button toggles play <-> stop based on what the desktop is
      // currently doing. Snapshot tells us the current pad state so we
      // can pick the right command without round-tripping.
      if (cmd === 'pad_play' && snapshot && snapshot.padPlaying) {
        cmd = 'pad_stop';
      }
      // Stop All two-tap gate.
      if (cmd === 'panic') {
        if (!btn.classList.contains('confirm-stop')) {
          btn.classList.add('confirm-stop');
          if (els.stopAllLabel) els.stopAllLabel.textContent = 'Tap to Confirm';
          stopConfirmTimer = setTimeout(exitStopConfirm, 3000);
          return;
        }
        exitStopConfirm();
        // fall through to send the panic command
      }
      send({ type: 'cmd', cmd });
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 200);
    });
  });
  // Cancel confirm-stop if the user taps anything else after arming it.
  document.addEventListener('click', (ev) => {
    if (!els.stopAllBtn || !els.stopAllBtn.classList.contains('confirm-stop')) return;
    if (ev.target && ev.target.closest && ev.target.closest('#stopAllBtn')) return;
    exitStopConfirm();
  }, true);

  // ---- Post-service prev/stop/next transport (only visible while
  //      post-service music is rolling — see render() for the swap).
  document.querySelectorAll('.post-transport-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!unlocked) return;
      const cmd = btn.dataset.cmd;
      if (!cmd) return;
      send({ type: 'cmd', cmd });
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 200);
    });
  });

  // ---- Pad key picker ----
  // 12-key grid in canonical order: C, D, E, ..., F#m. Disabled
  // unless the desktop has a pad mapped to that key (snapshot.padKeysAvailable).
  const ALL_PAD_KEYS = [
    'C', 'D', 'E', 'F', 'G', 'A', 'B', 'F#',
    'Cm', 'Dm', 'Em', 'Fm', 'Gm', 'Am', 'Bm', 'F#m',
  ];
  function buildPadKeyGrid() {
    if (!els.padKeyGrid) return;
    const available = new Set((snapshot && snapshot.padKeysAvailable) || []);
    const armed = (snapshot && snapshot.padArmedKey) || null;
    els.padKeyGrid.innerHTML = '';
    for (const key of ALL_PAD_KEYS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad-key-btn' + (key === armed ? ' active' : '');
      b.textContent = key;
      b.disabled = available.size > 0 && !available.has(key);
      b.addEventListener('click', () => {
        if (!unlocked) return;
        send({ type: 'cmd', cmd: 'set_pad_key', payload: { key } });
        // Optimistic UI — flip the active class immediately so the
        // tap feels instant; the snapshot will re-confirm on its
        // next push.
        els.padKeyGrid.querySelectorAll('.pad-key-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
      els.padKeyGrid.appendChild(b);
    }
  }
  function openPadKeyOverlay() {
    if (!els.padKeyOverlay) return;
    buildPadKeyGrid();
    els.padKeyOverlay.hidden = false;
  }
  function closePadKeyOverlay() {
    if (els.padKeyOverlay) els.padKeyOverlay.hidden = true;
  }
  if (els.padKeyPickBtn) {
    els.padKeyPickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!unlocked) return;
      openPadKeyOverlay();
    });
  }
  if (els.padKeyClose) {
    els.padKeyClose.addEventListener('click', closePadKeyOverlay);
  }
  if (els.padKeyOverlay) {
    els.padKeyOverlay.addEventListener('click', (e) => {
      if (e.target === els.padKeyOverlay) closePadKeyOverlay();
    });
  }

  // ---- Time-shift mini buttons (±2 min, two-step confirm) ----
  // First tap flips data-confirm=true and arms a 3 s timeout. A second
  // tap within that window commits and sends the cmd. Mirrors the
  // desktop pattern so an accidental thumb tap can't shift the service.
  document.querySelectorAll('.time-shift-mini').forEach(btn => {
    let resetTimer = null;
    const labelEl = btn;
    const originalLabel = btn.textContent;
    btn.addEventListener('click', () => {
      if (!unlocked) return;
      const cmd = btn.dataset.cmd;
      if (!cmd) return;
      const armed = btn.dataset.confirm === 'true';
      if (!armed) {
        btn.dataset.confirm = 'true';
        labelEl.textContent = `Confirm ${originalLabel}`;
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.dataset.confirm = 'false';
          labelEl.textContent = originalLabel;
          resetTimer = null;
        }, 3000);
        return;
      }
      send({ type: 'cmd', cmd });
      btn.dataset.confirm = 'false';
      labelEl.textContent = originalLabel;
      if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 200);
    });
  });

  // ---- Master volume slider ----
  // Locally-driven during touch (so the thumb tracks the finger 1:1)
  // and the snapshot only writes back when the user *isn't* dragging.
  // Without that guard, every snapshot would yank the slider to
  // wherever the desktop reported half a tick ago, fighting the user.
  let volDragging = false;
  let lastSentPct = 100;
  let pendingVolTimer = null;
  function paintMasterVol(pct, muted) {
    if (!els.masterVolSlider) return;
    if (!volDragging) els.masterVolSlider.value = String(pct);
    els.masterVolSlider.style.setProperty('--vol-pct', pct + '%');
    if (els.masterVolPct) els.masterVolPct.textContent = pct + '%';
    if (els.masterVolRow) els.masterVolRow.classList.toggle('muted', !!muted);
  }
  function sendVolume(pct) {
    if (!unlocked) return;
    if (pct === lastSentPct) return;
    lastSentPct = pct;
    send({ type: 'cmd', cmd: 'set_master_volume', payload: { pct } });
  }
  if (els.masterVolSlider) {
    const onSliderInput = () => {
      const pct = Math.round(Number(els.masterVolSlider.value || 0));
      paintMasterVol(pct, els.masterVolRow?.classList.contains('muted'));
      // Throttle to ~30 Hz so a rapid drag doesn't flood the WebSocket
      // with 100+ updates a second. The trailing send guarantees the
      // final position is always transmitted on touchend.
      if (pendingVolTimer) return;
      pendingVolTimer = setTimeout(() => {
        pendingVolTimer = null;
        sendVolume(pct);
      }, 33);
    };
    const onSliderEnd = () => {
      volDragging = false;
      if (pendingVolTimer) { clearTimeout(pendingVolTimer); pendingVolTimer = null; }
      sendVolume(Math.round(Number(els.masterVolSlider.value || 0)));
    };
    els.masterVolSlider.addEventListener('pointerdown', () => { volDragging = true; });
    els.masterVolSlider.addEventListener('input', onSliderInput);
    els.masterVolSlider.addEventListener('change', onSliderEnd);
    els.masterVolSlider.addEventListener('pointerup', onSliderEnd);
    els.masterVolSlider.addEventListener('pointercancel', onSliderEnd);
  }
  if (els.masterMuteBtn) {
    els.masterMuteBtn.addEventListener('click', () => {
      if (!unlocked) return;
      const next = !(els.masterVolRow?.classList.contains('muted'));
      els.masterVolRow?.classList.toggle('muted', next);
      send({ type: 'cmd', cmd: 'set_master_mute', payload: { muted: next } });
    });
  }

  // ---- Wake / network-change reconnect ----
  // When the phone screen turns back on or the page is restored from
  // bfcache, force a fresh WS connection — Safari likes to report
  // OPEN on a half-dead socket after the screen wakes. Same trick
  // for `online`: a Wi-Fi handoff usually leaves the prior socket
  // limp, so we tear it down rather than wait for the next packet
  // attempt to fail. Resets connectAttempt so the first retry is
  // the fast 500ms path, not the 2s back-off.
  function forceReconnect(reason) {
    connectAttempt = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setConn('connecting', `reconnecting (${reason})…`);
    connect();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Only reconnect if we're not currently live — saves a needless
      // teardown when the user just briefly switched apps.
      if (!ws || ws.readyState !== WebSocket.OPEN) forceReconnect('wake');
    }
  });
  window.addEventListener('pageshow', (e) => {
    // bfcache restore — `e.persisted` is true. Treat as wake.
    if (e.persisted) forceReconnect('restore');
  });
  window.addEventListener('online', () => forceReconnect('online'));

  // ---- Header lock button ----
  els.hdrLockBtn.addEventListener('click', () => {
    send({ type: 'lock' });
  });

  // ---- MIDI monitor ----
  // Shared row builder so the inline preview and the full-screen overlay
  // render identically. Compact one-line format keeps the iPhone view
  // readable: "12:43 NOTE  ch1 60(127) IAC · panic_fade".
  function fmtClockTime(ts) {
    // 12-hour clock with AM/PM. Drops the seconds-only padding to
    // keep the row compact; AM/PM lives in a small uppercase suffix.
    const d = new Date(ts);
    const h24 = d.getHours();
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = ((h24 + 11) % 12) + 1;
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${h12}:${m}:${s} ${ampm}`;
  }
  function buildMidiRow(entry) {
    const row = document.createElement('div');
    row.className = 'mm-row';
    const time = document.createElement('span');
    time.className = 'mm-time';
    time.textContent = fmtClockTime(entry.ts);
    const type = document.createElement('span');
    type.className = 'mm-type';
    type.textContent = entry.type;
    const detail = document.createElement('span');
    detail.className = 'mm-detail';
    let detailText = `ch${entry.ch} ${entry.d1}`;
    if (entry.d2 !== 0) detailText += `(${entry.d2})`;
    if (entry.device) detailText += ` · ${entry.device}`;
    detail.textContent = detailText;
    row.appendChild(time);
    row.appendChild(type);
    row.appendChild(detail);
    if (entry.action) {
      const action = document.createElement('span');
      action.className = 'mm-action';
      action.textContent = '→ ' + entry.action;
      row.appendChild(action);
    }
    return row;
  }

  // Track what we last rendered to skip work when nothing changed.
  let lastInlineSig = '';
  let lastOverlaySig = '';
  let midiOverlayOpen = false;

  function renderMidiInline(entries) {
    if (!entries || entries.length === 0) {
      els.midiMonitor.hidden = true;
      lastInlineSig = '';
      return;
    }
    els.midiMonitor.hidden = false;
    // Show last 3 entries, newest first.
    const recent = entries.slice(-3).reverse();
    const sig = recent.map(e => `${e.ts}-${e.type}-${e.ch}-${e.d1}-${e.d2}`).join('|');
    if (sig === lastInlineSig) return;
    lastInlineSig = sig;
    els.midiRecent.innerHTML = '';
    for (const e of recent) els.midiRecent.appendChild(buildMidiRow(e));
  }

  function renderMidiOverlay(entries) {
    if (!midiOverlayOpen) return;
    const list = entries || [];
    const sig = list.length ? `${list[0].ts}-${list[list.length - 1].ts}-${list.length}` : 'empty';
    if (sig === lastOverlaySig) return;
    lastOverlaySig = sig;
    els.midiAll.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mm-empty';
      empty.textContent = 'No MIDI traffic yet.';
      els.midiAll.appendChild(empty);
      return;
    }
    // column-reverse flex layout in CSS — append in chronological order
    // and the visual flow puts newest at the top.
    for (const e of list) els.midiAll.appendChild(buildMidiRow(e));
  }

  els.midiViewAll.addEventListener('click', () => {
    midiOverlayOpen = true;
    lastOverlaySig = '';
    els.midiOverlay.hidden = false;
    if (snapshot) renderMidiOverlay(snapshot.recentMidi);
  });
  els.midiClose.addEventListener('click', () => {
    midiOverlayOpen = false;
    els.midiOverlay.hidden = true;
  });
  // Clear buttons — wipe the MIDI activity log on the host. Both the
  // inline (next to "View all") and the overlay button send the same
  // command; the snapshot push will broadcast the empty list back.
  const clearMidi = () => send({ type: 'cmd', cmd: 'clear_midi_log' });
  els.midiClear?.addEventListener('click', clearMidi);
  els.midiClearOverlay?.addEventListener('click', clearMidi);

  // ---- Render loop ----
  function fmtDuration(ms, withMs = false) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const base = h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (!withMs) return base;
    // Centiseconds (00-99) — two digits read cleanly at a glance;
    // three-digit milliseconds jitter too fast to be useful.
    const cs = Math.floor((ms % 1000) / 10);
    return `${base}.${String(cs).padStart(2, '0')}`;
  }
  function fmtMmSs(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // "13:00" → "1:00 PM". Service times come in 24-hour HH:MM from the
  // server; the operator typically thinks in 12-hour clock so we display
  // accordingly.
  function fmt12h(hhmm) {
    if (typeof hhmm !== 'string') return hhmm || '';
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return hhmm;
    const h24 = +m[1];
    const min = m[2];
    const period = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${min} ${period}`;
  }

  function deriveTimerState(snap, now) {
    if (!snap) return { kind: 'no-snapshot' };
    const r = snap.runway;
    const target = snap.activeService ? snap.activeService.targetMs : 0;
    if (r && r.phase === 'pad' && r.padOffMs && r.padOffMs > now) {
      return { kind: 'pad-finishing', targetMs: r.padOffMs, label: 'Pad off in' };
    }
    if (r && r.isPostService && r.postEndMs && r.postEndMs > now) {
      return { kind: 'post-service', targetMs: r.postEndMs, label: 'Post-service ends in' };
    }
    if (target > now) {
      const armedHere = !!(r && r.serviceId === (snap.activeService && snap.activeService.id));
      const preMusic = armedHere && r && r.phase === 'queued';
      return { kind: preMusic ? 'pre-music' : 'service', targetMs: target, label: 'Service starts in' };
    }
    return { kind: 'idle', label: 'Idle' };
  }

  function render() {
    const now = Date.now();
    const snap = snapshot;

    if (snap && now - lastSnapshotAt > 5000) setConn('lost', 'reconnecting…');

    // Master volume mirror — drives the slider position when the user
    // isn't actively dragging. Snapshot is the source of truth.
    if (snap && typeof snap.masterPct === 'number') {
      paintMasterVol(snap.masterPct, !!snap.masterMuted);
    }

    // Post-service transport swap — single Play button while idle,
    // Prev/Next pair while music is rolling. Both `hidden` and the
    // `.visible` class are set so the swap is robust against CSS
    // specificity weirdness (`hidden` alone gets overridden if any
    // rule sets display !important).
    if (snap) {
      const r = snap.runway;
      const postRolling = !!(r && r.isPostService && r.phase === 'music');
      if (els.postServiceBtn) els.postServiceBtn.hidden = postRolling;
      if (els.postTransport) {
        els.postTransport.hidden = !postRolling;
        els.postTransport.classList.toggle('visible', postRolling);
      }
    }

    // Pad armed-key chip on the Pad Play button.
    if (snap && els.padArmedKeyChip) {
      const k = snap.padArmedKey;
      if (k) {
        els.padArmedKeyChip.textContent = k;
        els.padArmedKeyChip.hidden = false;
      } else {
        els.padArmedKeyChip.hidden = true;
      }
    }

    // Fade-to-Pad toggle visual state. When engaged: button pulses
    // pink, label flips to "Music Back In", icon swaps to a reversed
    // wave so the operator instantly reads "tap to recover."
    if (snap && els.fadeToPadBtn) {
      const engaged = !!snap.fadeToPadActive;
      els.fadeToPadBtn.classList.toggle('engaged', engaged);
      if (els.fadeToPadLabel) {
        els.fadeToPadLabel.textContent = engaged ? 'Music Back In' : 'Fade to Pad';
      }
      if (els.fadeToPadIcon) {
        els.fadeToPadIcon.innerHTML = engaged
          ? '<path d="M3 12 Q5 18 7 12 T11 12 T15 12 T19 12 T23 12"/><path d="M8 6L4 10l4 4"/>'
          : '<path d="M3 12 Q5 6 7 12 T11 12 T15 12 T19 12 T23 12"/><path d="M16 6l4 4-4 4"/>';
      }
    }

    if (snap && snap.activeService) {
      els.serviceName.textContent = snap.activeService.name || fmt12h(snap.activeService.startTime) || 'Service';
      els.serviceStatus.textContent = (snap.activeService.status || 'scheduled').toUpperCase();
      // Show the start time under the status lights when it's not
      // already the service's display name (avoids "1:00 PM / 1:00 PM").
      els.hdrTime.textContent = snap.activeService.name
        ? fmt12h(snap.activeService.startTime)
        : '';
    } else if (snap) {
      els.serviceName.textContent = 'No service';
      els.serviceStatus.textContent = 'IDLE';
      els.hdrTime.textContent = '';
    } else {
      els.serviceName.textContent = '—';
      els.serviceStatus.textContent = 'OFFLINE';
      els.hdrTime.textContent = '';
    }

    const state = deriveTimerState(snap, now);
    els.timerWrap.dataset.state = state.kind;
    if (state.targetMs) {
      const remainingMs = Math.max(0, state.targetMs - now);
      // Centiseconds visible across all phases — service start, pad
      // finishing, and post-service all show .00–.99 ticking.
      els.timer.textContent = fmtDuration(remainingMs, true);
      els.timerLabel.textContent = state.label;
      // Drive a narrower font size when hours are present so
      // `HH:MM:SS.cs` (11 chars) doesn't overflow narrow phones.
      els.timerWrap.dataset.hasHours = remainingMs >= 3_600_000 ? 'true' : 'false';
    } else {
      els.timer.textContent = '00:00:00';
      els.timerLabel.textContent = state.label || 'Idle';
      els.timerWrap.dataset.hasHours = 'false';
    }
    els.timerMeta.textContent = '';

    if (snap && snap.nowPlaying && snap.nowPlaying.title) {
      els.nowPlayingWrap.hidden = false;
      els.npTitle.textContent = snap.nowPlaying.title + (snap.nowPlaying.artist ? ` · ${snap.nowPlaying.artist}` : '');
      els.npPos.textContent = `${fmtMmSs(snap.nowPlaying.positionSec)} / ${fmtMmSs(snap.nowPlaying.durationSec)}`;
      // Art — only swap the src when the URL changes so we don't
      // re-decode the data URL on every snapshot tick.
      if (els.npArt && els.npArtPlaceholder) {
        const url = snap.nowPlaying.albumArtUrl || '';
        if (url) {
          if (els.npArt.src !== url) els.npArt.src = url;
          els.npArt.hidden = false;
          els.npArtPlaceholder.hidden = true;
        } else {
          els.npArt.hidden = true;
          els.npArtPlaceholder.hidden = false;
        }
      }
      if (snap.nextTrack && snap.nextTrack.title) {
        els.npNextWrap.hidden = false;
        els.npNext.textContent = snap.nextTrack.title + (snap.nextTrack.artist ? ` · ${snap.nextTrack.artist}` : '');
      } else {
        els.npNextWrap.hidden = true;
      }
    } else {
      els.nowPlayingWrap.hidden = true;
    }

    // Status lights — match whatever the desktop top bar shows.
    if (snap && snap.status) {
      els.lightMidi.dataset.state = snap.status.midi;
      els.lightPp.dataset.state = snap.status.pp;
      els.lightAudio.dataset.state = snap.status.audio;
    }

    // MIDI monitor — inline preview always (when there's traffic), full
    // overlay only when the user opened it.
    if (snap) {
      renderMidiInline(snap.recentMidi);
      renderMidiOverlay(snap.recentMidi);
    }

    // Arm/Disarm dynamic state. The confirm-disarm flag is driven by
    // the desktop controller so the visual matches whatever's already
    // showing on the operator's main screen.
    if (snap && unlocked) {
      const armed = !!snap.armed;
      const confirming = !!snap.armConfirmDisarm;
      els.armLabel.textContent = confirming ? 'Tap to disarm' : (armed ? 'Disarm' : 'Arm');
      els.armBtn.classList.toggle('armed', armed && !confirming);
      els.armBtn.classList.toggle('confirm-disarm', confirming);

      const padPlaying = !!snap.padPlaying;
      els.padLabel.textContent = padPlaying ? 'Pad Stop' : 'Pad Play';
      els.padBtn.classList.toggle('playing', padPlaying);

      // Music Early + Shuffle only matter during the pre-service
      // queued window (a service is armed but music hasn't fired yet).
      // After that, both are no-ops on the desktop — hide them to keep
      // the action grid clean.
      if (els.miniActions) {
        const r = snap.runway;
        const showMini = armed && !!r && r.phase === 'queued' && !r.isPostService;
        els.miniActions.hidden = !showMini;
      }
    }

    requestAnimationFrame(render);
  }

  // "Forget saved PIN" — clear the cached PIN so the next swipe opens
  // the keypad instead of auto-submitting. Handy when switching between
  // operator and viewer roles after PINs have been rotated on the
  // desktop. Also lock the current session (if any) so they fall back
  // to the lock screen immediately.
  if (els.forgetPinBtn) {
    els.forgetPinBtn.addEventListener('click', () => {
      clearSavedPin();
      autoSubmittedPin = false;
      lastSubmittedPin = '';
      if (unlocked) send({ type: 'lock' });
    });
  }
  // Seed the Forget button visibility on first paint.
  refreshForgetPinBtn();

  connect();
  requestAnimationFrame(render);
})();
