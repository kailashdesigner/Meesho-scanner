(() => {
  "use strict";

  // ---------------------------
  // App state
  // ---------------------------
  const MAX_SHIPMENTS = 64;
  // Paste your deployed Google Apps Script Web App URL here (it will end with `/exec`).
  // Example: https://script.google.com/macros/s/XXXXX/exec
  // If left blank, the scanner UI will work but Google Sheets sync will be disabled.
  const GOOGLE_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbyfCT4sCJp3n8XLcB1M-7mWz50WbaPJsztJxfuCFMUHty7v52fs3bS3h-z0KSq3HW74/exec";

  const scannedValues = [];
  const lastSeenAt = new Map(); // value -> last time added (for dedupe)
  const DUP_DEBOUNCE_MS = 2500;

  const SESSION_ID = (() => {
    try {
      const existing = sessionStorage.getItem("scannerSessionId");
      if (existing) return existing;
      const created = `sess_${Math.random().toString(16).slice(2)}_${Date.now()}`;
      sessionStorage.setItem("scannerSessionId", created);
      return created;
    } catch (_) {
      return `sess_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    }
  })();

  let html5QrcodeScanner = null;
  let scannerRunning = false;
  let scannerStarting = false;
  let goalReachedShown = false;

  // Google Sheets sync queue (so we don't block scanning).
  let sheetQueue = [];
  let sheetDraining = false;
  let lastSheetErrorToastAt = 0;

  // ---------------------------
  // DOM helpers
  // ---------------------------
  const $ = (id) => document.getElementById(id);
  const homeScreen = $("homeScreen");
  const scannerScreen = $("scannerScreen");

  const cameraBtn = $("cameraBtn");
  const backBtn = $("backBtn");

  const homeInput = $("homeInput");
  const scannedCountHome = $("scannedCountHome");

  const cameraStatus = $("cameraStatus");
  const progressCount = $("progressCount");
  const progressTotal = $("progressTotal");
  const progressPercent = $("progressPercent");

  const manualBtn = $("manualBtn");
  const hhdBtn = $("hhdBtn");

  const modal = $("modal");
  const modalTitle = $("modalTitle");
  const modalInput = $("modalInput");
  const modalCancel = $("modalCancel");
  const modalSave = $("modalSave");

  const toast = $("toast");

  const loadingOverlay = $("loadingOverlay");
  const scannerViewport = $("scannerViewport");

  // ---------------------------
  // Utilities
  // ---------------------------
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function sanitizeValue(value) {
    // Keep it conservative: trim, collapse spaces. Do not transform aggressively.
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    // Allow transition to apply
    requestAnimationFrame(() => toast.classList.add("show"));
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => {
      toast.classList.remove("show");
      window.setTimeout(() => toast.classList.add("hidden"), 180);
    }, 1800);
  }

  function setCameraStatus(message, isError = false) {
    if (!message) {
      cameraStatus.textContent = "";
      cameraStatus.classList.add("hidden");
      return;
    }
    cameraStatus.textContent = message;
    cameraStatus.classList.remove("hidden");
    if (isError) {
      cameraStatus.style.background = "rgba(255, 47, 47, 0.14)";
      cameraStatus.style.borderColor = "rgba(255, 47, 47, 0.30)";
    } else {
      cameraStatus.style.background = "rgba(255,255,255,0.06)";
      cameraStatus.style.borderColor = "rgba(255,255,255,0.14)";
    }
  }

  function updateProgressUI() {
    const count = scannedValues.length;
    scannedCountHome.textContent = String(count);

    progressCount.textContent = String(count);
    progressTotal.textContent = String(MAX_SHIPMENTS);

    const percent = Math.round((count / MAX_SHIPMENTS) * 100);
    const safePercent = clamp(percent, 0, 100);
    progressPercent.textContent = String(safePercent);
  }

  function enqueueSheetSync(value, source) {
    if (!GOOGLE_SHEETS_WEB_APP_URL || GOOGLE_SHEETS_WEB_APP_URL.includes("PASTE_YOUR_GOOGLE_APPS_SCRIPT_URL_HERE")) {
      return;
    }

    sheetQueue.push({
      value,
      source,
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
    });

    // Best-effort prevent unbounded growth if network is down.
    if (sheetQueue.length > 500) sheetQueue.shift();
    void drainSheetQueue();
  }

  async function drainSheetQueue() {
    if (sheetDraining) return;
    if (!sheetQueue.length) return;

    sheetDraining = true;
    try {
      while (sheetQueue.length) {
        const item = sheetQueue.shift();
        const payload = JSON.stringify(item);

        // Use text/plain + no-cors to avoid common Apps Script CORS/preflight issues.
        await fetch(GOOGLE_SHEETS_WEB_APP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
          },
          body: payload,
          // Some environments require following redirects for Apps Script.
          redirect: "follow",
          mode: "no-cors",
        });
      }
    } catch (err) {
      const now = Date.now();
      if (now - lastSheetErrorToastAt > 6000) {
        lastSheetErrorToastAt = now;
        showToast("Sync to Google Sheets failed. Will keep trying.");
      }
    } finally {
      sheetDraining = false;
      // If new items arrived during failure, try again.
      if (sheetQueue.length) void drainSheetQueue();
    }
  }

  function vibrateIfSupported() {
    try {
      if ("vibrate" in navigator) navigator.vibrate(35);
    } catch (_) {
      // Ignore
    }
  }

  function beepIfSupported() {
    // Some browsers require a user gesture; scanning/manual input are user-triggered.
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = 980;
      gain.gain.value = 0.06;

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      setTimeout(() => {
        try {
          osc.stop();
          ctx.close();
        } catch (_) {
          // Ignore
        }
      }, 110);
    } catch (_) {
      // Ignore audio errors
    }
  }

  function addScannedValue(rawValue, source = "scan") {
    const value = sanitizeValue(rawValue);
    if (!value) return false;

    const now = Date.now();
    const last = lastSeenAt.get(value) || 0;
    if (now - last < DUP_DEBOUNCE_MS) {
      // Prevent repeated increments when barcode stays in frame.
      return false;
    }
    lastSeenAt.set(value, now);

    scannedValues.push(value);
    updateProgressUI();

    // Sync to Google Sheets (non-blocking).
    enqueueSheetSync(value, source);

    // Feedback to the user
    vibrateIfSupported();
    beepIfSupported();
    showToast(`${source === "scan" ? "Scanned" : "Added"}: ${value}`);

    if (!goalReachedShown && scannedValues.length >= MAX_SHIPMENTS) {
      goalReachedShown = true;
      showToast("64 shipments goal reached. Continuing scan...");
    }

    return true;
  }

  // ---------------------------
  // Modal handling
  // ---------------------------
  let modalMode = "manual";
  function openModal(title, placeholder) {
    modalMode = "manual";
    modalTitle.textContent = title;
    modalInput.value = "";
    modalInput.placeholder = placeholder || "Type value here...";
    modal.classList.remove("hidden");
    // Focus after paint
    requestAnimationFrame(() => modalInput.focus());
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  modalCancel.addEventListener("click", () => closeModal());
  modalSave.addEventListener("click", () => {
    const v = modalInput.value;
    closeModal();
    addScannedValue(v, "manual");
  });
  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") modalSave.click();
    if (e.key === "Escape") closeModal();
  });

  // ---------------------------
  // Screen transitions
  // ---------------------------
  function showScannerScreen() {
    homeScreen.classList.remove("active");
    scannerScreen.classList.add("active");
  }

  function showHomeScreen() {
    scannerScreen.classList.remove("active");
    homeScreen.classList.add("active");
    // Keep focus usability
    requestAnimationFrame(() => {
      homeInput.focus();
      homeInput.select?.();
    });
  }

  // ---------------------------
  // Camera scanning integration
  // ---------------------------
  function showLoading(isLoading) {
    if (isLoading) loadingOverlay.classList.remove("hidden");
    else loadingOverlay.classList.add("hidden");
  }

  function shouldRetryWithUserFacing(err) {
    // Only retry if it's not an explicit denial / unsupported.
    const msg = String(err && (err.message || err.name || err.toString())).toLowerCase();
    const denied = msg.includes("denied") || msg.includes("permission");
    if (denied) return false;
    return true;
  }

  async function startScanner() {
    if (scannerRunning || scannerStarting) return;
    scannerStarting = true;
    setCameraStatus("", false);
    showLoading(true);

    try {
      // Create a fresh instance when re-opening, for more reliable lifecycle.
      html5QrcodeScanner = new Html5Qrcode("scannerViewport");

      const onSuccess = (decodedText) => {
        // decodedText can be empty or unexpected
        if (!decodedText) return;
        addScannedValue(decodedText, "scan");
      };

      const onError = (_err) => {
        // Ignore most "no code found" errors to avoid UI spam.
      };

      // Start with rear camera
      try {
        await html5QrcodeScanner.start(
          { facingMode: "environment" },
          undefined,
          onSuccess,
          onError
        );
      } catch (err) {
        if (shouldRetryWithUserFacing(err)) {
          await html5QrcodeScanner.start({ facingMode: "user" }, undefined, onSuccess, onError);
        } else {
          throw err;
        }
      }

      scannerRunning = true;
      setCameraStatus("", false);
    } catch (err) {
      const msg = String(err && (err.message || err.name || err.toString())).trim();
      const friendly =
        msg && msg.toLowerCase().includes("permission")
          ? "Camera permission denied. Please allow camera access or use manual input."
          : "Unable to start camera. Please allow camera access or use manual input.";
      setCameraStatus(friendly, true);
      showToast("Camera could not start.");
      scannerRunning = false;
    } finally {
      showLoading(false);
      scannerStarting = false;
    }
  }

  async function stopScanner() {
    if (!scannerRunning && !scannerStarting) return;
    try {
      scannerRunning = false;
      if (html5QrcodeScanner) {
        // stop() closes the stream
        await html5QrcodeScanner.stop();
      }
    } catch (_) {
      // Ignore stop errors
    } finally {
      scannerStarting = false;
      // Best effort clear
      try {
        html5QrcodeScanner?.clear?.();
      } catch (_) {
        // Ignore
      }
    }
  }

  // ---------------------------
  // Event wiring
  // ---------------------------
  cameraBtn.addEventListener("click", async () => {
    showScannerScreen();
    // Ensure we start even if previous instance failed.
    await startScanner();
  });

  backBtn.addEventListener("click", async () => {
    await stopScanner();
    showHomeScreen();
  });

  homeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = homeInput.value;
      addScannedValue(v, "manual");
      homeInput.value = "";
    }
  });

  manualBtn.addEventListener("click", () => {
    openModal("Enter Waybill no.", "Type waybill number...");
  });

  hhdBtn.addEventListener("click", () => {
    openModal("HHD Input", "Type HHD value...");
  });

  // ---------------------------
  // Init
  // ---------------------------
  updateProgressUI();
  showLoading(false);

  // Accessibility: close modal by clicking backdrop
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
})();
