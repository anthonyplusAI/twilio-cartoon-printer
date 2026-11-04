(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const video = $("video");
    const canvas = $("canvas");
    const preview = $("preview");
    const countdown = $("countdown");
    const status = $("status");
    const startBtn = $("startBtn");
    const snapBtn = $("snapBtn");
    const confirmBtn = $("confirmBtn");
    const retakeBtn = $("retakeBtn");
    const cancelBtn = $("cancelBtn");
    const againBtn = $("againBtn");
    const styleSel = $("styleSel");
    const brandSel = $("brandSel");
    const backgroundSel = $("backgroundSel");
    const phoneInput = $("phoneInput");
    const emailInput = $("emailInput");
    const consentInput = $("consentInput");
    const whatsappOptIn = $("whatsappOptIn");

    const IDLE_MS = 120000;
    const UPLOAD_TIMEOUT_MS = 30000;
    const DONE_RESET_MS = 15000;
    let state = "idle";
    let stream = null;
    let capturedBlob = null;
    let requestId = null;
    let uploadController = null;
    let abortReason = "";
    let sessionEpoch = 0;
    let idleTimer = null;
    let doneTimer = null;

    function format(key, values) {
        let result = KIOSK_COPY[key] || key;
        for (const [name, value] of Object.entries(values || {})) {
            result = result.split("{" + name + "}").join(String(value));
        }
        return result;
    }

    function setStatus(key, values, focus) {
        status.textContent = format(key, values);
        if (focus) status.focus();
    }

    function show(id) { $(id).classList.remove("hidden"); }
    function hide(id) { $(id).classList.add("hidden"); }

    function makeRequestId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, (part) => part.toString(16).padStart(2, "0")).join("");
        return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16)
            + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }

    function addOption(select, key, name) {
        const option = document.createElement("option");
        option.value = key;
        option.textContent = name;
        select.appendChild(option);
    }

    function populateStyles() {
        styleSel.replaceChildren();
        if (STYLES.length > 1) addOption(styleSel, "", KIOSK_COPY.chooseStyle);
        for (const option of STYLES) addOption(styleSel, option.key, option.name);
        if (STYLES.length === 1) styleSel.value = STYLES[0].key;
        styleSel.disabled = STYLES.length === 0;
    }

    function populateBrands() {
        brandSel.replaceChildren();
        $("brand-field").classList.toggle("hidden", BRAND_OPTIONS.length === 0);
        if (BRAND_OPTIONS.length > 1) addOption(brandSel, "", KIOSK_COPY.chooseBrand);
        for (const option of BRAND_OPTIONS) addOption(brandSel, option.key, option.name);
        if (BRAND_OPTIONS.length === 1) brandSel.value = BRAND_OPTIONS[0].key;
    }

    function selectedBrand() {
        return BRAND_OPTIONS.length ? brandSel.value : AUTO_BRAND_KEY;
    }

    function currentBackgroundStep() {
        return BACKGROUND_MATRIX[styleSel.value + "|" + selectedBrand()] || { kind: "skip", options: [] };
    }

    function updateBackground() {
        backgroundSel.replaceChildren();
        const step = currentBackgroundStep();
        const showMenu = step.kind === "menu";
        $("background-field").classList.toggle("hidden", !showMenu);
        if (showMenu) {
            addOption(backgroundSel, "", KIOSK_COPY.chooseBackground);
            for (const option of step.options) addOption(backgroundSel, option.key, option.name);
        }
    }

    function selectedChannel() {
        const checked = document.querySelector('input[name="deliveryChannel"]:checked');
        return checked ? checked.value : "";
    }

    function updateDelivery() {
        const channel = selectedChannel();
        const phoneChannel = channel === "sms" || channel === "whatsapp";
        $("phone-field").classList.toggle("hidden", !phoneChannel);
        $("email-field").classList.toggle("hidden", channel !== "email");
        $("whatsapp-opt-in-row").classList.toggle("hidden", channel !== "whatsapp");
        if (!phoneChannel) phoneInput.value = "";
        if (channel !== "email") emailInput.value = "";
        if (channel !== "whatsapp") whatsappOptIn.checked = false;
    }

    function stopCamera() {
        if (stream) {
            for (const track of stream.getTracks()) track.stop();
            stream = null;
        }
        video.srcObject = null;
    }

    function clearPreview() {
        if (preview.src && preview.src.startsWith("blob:")) URL.revokeObjectURL(preview.src);
        preview.removeAttribute("src");
        preview.classList.add("hidden");
        video.classList.remove("hidden");
        capturedBlob = null;
    }

    function clearGuestInputs() {
        phoneInput.value = "";
        emailInput.value = "";
        consentInput.checked = false;
        whatsappOptIn.checked = false;
        for (const radio of document.querySelectorAll('input[name="deliveryChannel"]')) {
            radio.checked = DELIVERY_CHANNELS.length === 1;
        }
        updateDelivery();
    }

    function scheduleIdle() {
        clearTimeout(idleTimer);
        if (state === "idle" || state === "done") return;
        idleTimer = setTimeout(() => resetAll("idleCleared"), IDLE_MS);
    }

    function noteActivity() {
        scheduleIdle();
    }

    function resetAll(statusKey) {
        sessionEpoch += 1;
        clearTimeout(idleTimer);
        clearTimeout(doneTimer);
        if (uploadController) uploadController.abort();
        uploadController = null;
        stopCamera();
        clearPreview();
        clearGuestInputs();
        requestId = null;
        abortReason = "";
        state = "idle";
        populateStyles();
        populateBrands();
        updateBackground();
        hide("review-panel");
        hide("done-card");
        show("stage");
        show("controls-capture");
        show("status");
        startBtn.disabled = STYLES.length === 0 || DELIVERY_CHANNELS.length === 0;
        startBtn.classList.remove("hidden");
        snapBtn.disabled = true;
        confirmBtn.disabled = false;
        retakeBtn.disabled = false;
        hide("cancelBtn");
        countdown.classList.remove("on");
        countdown.textContent = "";
        if (STYLES.length === 0) setStatus("noStyles", null, true);
        else if (DELIVERY_CHANNELS.length === 0) setStatus("noDeliveryChannels", null, true);
        else setStatus(statusKey || "startPrompt", null, false);
        startBtn.focus();
    }

    function withTimeout(promise, milliseconds) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout")), milliseconds);
            Promise.resolve(promise).then(
                (value) => { clearTimeout(timer); resolve(value); },
                (error) => { clearTimeout(timer); reject(error); }
            );
        });
    }

    function waitForFrame() {
        if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("camera-not-ready")), 8000);
            function finish(error) {
                clearTimeout(timer);
                video.removeEventListener("loadeddata", check);
                video.removeEventListener("canplay", check);
                video.removeEventListener("error", fail);
                if (error) reject(error);
                else resolve();
            }
            function check() {
                if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) finish();
            }
            function fail() { finish(new Error("camera-error")); }
            video.addEventListener("loadeddata", check);
            video.addEventListener("canplay", check);
            video.addEventListener("error", fail);
            check();
        });
    }

    async function startCamera() {
        if (STYLES.length === 0 || DELIVERY_CHANNELS.length === 0) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setStatus("cameraUnavailable", null, true);
            return;
        }
        const epoch = sessionEpoch;
        startBtn.disabled = true;
        setStatus("requestingCamera");
        try {
            const candidate = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
                audio: false,
            });
            if (epoch !== sessionEpoch) {
                candidate.getTracks().forEach((track) => track.stop());
                return;
            }
            stream = candidate;
            video.srcObject = candidate;
            await withTimeout(video.play(), 10000);
            await waitForFrame();
            if (epoch !== sessionEpoch) return;
            for (const track of candidate.getVideoTracks()) {
                track.addEventListener("ended", () => {
                    if (stream !== candidate || state !== "capture") return;
                    stopCamera();
                    show("startBtn");
                    startBtn.disabled = false;
                    snapBtn.disabled = true;
                    setStatus("cameraUnavailable", null, true);
                });
            }
            state = "capture";
            startBtn.classList.add("hidden");
            snapBtn.disabled = false;
            setStatus("takePhotoPrompt");
            snapBtn.focus();
            scheduleIdle();
        } catch {
            if (epoch !== sessionEpoch) return;
            stopCamera();
            startBtn.disabled = false;
            startBtn.classList.remove("hidden");
            snapBtn.disabled = true;
            setStatus("cameraUnavailable", null, true);
        }
    }

    async function runCountdown(epoch) {
        countdown.classList.add("on");
        for (let remaining = 3; remaining > 0; remaining -= 1) {
            if (epoch !== sessionEpoch) return false;
            countdown.textContent = String(remaining);
            await new Promise((resolve) => setTimeout(resolve, 850));
        }
        countdown.classList.remove("on");
        countdown.textContent = "";
        return epoch === sessionEpoch;
    }

    async function snap() {
        if (state !== "capture" || !stream) return;
        const epoch = sessionEpoch;
        snapBtn.disabled = true;
        scheduleIdle();
        try {
            if (!await runCountdown(epoch)) return;
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (!width || !height) throw new Error("missing-video-frame");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("missing-canvas");
            // CSS mirrors only the live preview. The video frame supplied to
            // canvas is already in its original orientation.
            context.drawImage(video, 0, 0, width, height);
            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob((result) => result ? resolve(result) : reject(new Error("encode-failed")), "image/jpeg", 0.92);
            });
            if (epoch !== sessionEpoch) return;
            capturedBlob = blob;
            requestId = makeRequestId();
            preview.src = URL.createObjectURL(blob);
            stopCamera();
            video.classList.add("hidden");
            preview.classList.remove("hidden");
            state = "review";
            hide("controls-capture");
            show("review-panel");
            updateBackground();
            updateDelivery();
            setStatus("photoConfirm");
            if (STYLES.length > 1) styleSel.focus();
            else if (BRAND_OPTIONS.length > 1) brandSel.focus();
            else {
                const radio = document.querySelector('input[name="deliveryChannel"]:checked')
                    || document.querySelector('input[name="deliveryChannel"]');
                if (radio) radio.focus();
            }
            scheduleIdle();
        } catch {
            if (epoch !== sessionEpoch) return;
            setStatus("captureFailed", null, true);
        } finally {
            countdown.classList.remove("on");
            countdown.textContent = "";
            if (state === "capture" && stream) snapBtn.disabled = false;
        }
    }

    function retake() {
        if (state !== "review") return;
        sessionEpoch += 1;
        clearPreview();
        clearGuestInputs();
        requestId = null;
        hide("review-panel");
        show("controls-capture");
        state = "idle";
        setStatus("retakePrompt");
        startCamera();
    }

    function selectedBackground() {
        const step = currentBackgroundStep();
        if (step.kind === "auto") return step.selected;
        return step.kind === "menu" ? backgroundSel.value : "";
    }

    function validateSelection() {
        if (!styleSel.value) {
            setStatus("chooseStyle", null, true);
            styleSel.focus();
            return null;
        }
        if (BRAND_OPTIONS.length && !brandSel.value) {
            setStatus("chooseBrandError", null, true);
            brandSel.focus();
            return null;
        }
        const background = selectedBackground();
        if (currentBackgroundStep().kind === "menu" && !background) {
            setStatus("chooseBackgroundError", null, true);
            backgroundSel.focus();
            return null;
        }
        const channel = selectedChannel();
        if (!DELIVERY_CHANNELS.includes(channel)) {
            setStatus("chooseDelivery", null, true);
            const radio = document.querySelector('input[name="deliveryChannel"]');
            if (radio) radio.focus();
            return null;
        }
        let destination = "";
        if (channel === "email") {
            destination = emailInput.value.trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)) {
                setStatus("invalidEmailRequired", null, true);
                emailInput.focus();
                return null;
            }
        } else {
            destination = phoneInput.value.trim();
            if (!/^\+[1-9]\d{6,14}$/.test(destination)) {
                setStatus("invalidPhoneRequired", null, true);
                phoneInput.focus();
                return null;
            }
        }
        if (channel === "whatsapp" && !whatsappOptIn.checked) {
            setStatus("mustAgreeWhatsapp", null, true);
            whatsappOptIn.focus();
            return null;
        }
        if (!consentInput.checked) {
            setStatus("mustAgreeNotice", null, true);
            consentInput.focus();
            return null;
        }
        return { channel, destination, background };
    }

    function apiErrorKey(statusCode, code) {
        const byCode = {
            EVENT_CHANGED: "eventChanged",
            EVENT_OPTIONS_CHANGED: "eventChanged",
            STYLE_INVALID: "eventChanged",
            BRAND_INVALID: "eventChanged",
            BACKGROUND_INVALID: "eventChanged",
            DELIVERY_UNAVAILABLE: "deliveryUnavailable",
            CHANNEL_UNAVAILABLE: "deliveryUnavailable",
            QUOTA_REACHED: "quotaReached",
            INVALID_DESTINATION: "invalidDestination",
            DESTINATION_INVALID: "invalidDestination",
            REQUEST_IN_PROGRESS: "uploadInProgress",
            REQUEST_ID_CONFLICT: "submissionConflict",
            KIOSK_SESSION_EXPIRED: "kioskSessionExpired",
            KIOSK_ONLY: "kioskSessionExpired",
        };
        if (byCode[code]) return byCode[code];
        if (statusCode === 401) return "kioskSessionExpired";
        if (statusCode === 409) return "deliveryUnavailable";
        if (statusCode === 429) return "quotaReached";
        if (statusCode === 503) return "deliveryUnavailable";
        return "uploadFailed";
    }

    function showSessionExpired(statusKey = "kioskSessionExpired") {
        stopCamera();
        clearPreview();
        clearGuestInputs();
        requestId = null;
        state = "expired";
        clearTimeout(idleTimer);
        hide("stage");
        hide("review-panel");
        hide("controls-capture");
        hide("cancelBtn");
        show("status");
        setStatus(statusKey, null, true);
    }

    async function generate() {
        if (state !== "review" || !capturedBlob) return;
        const selection = validateSelection();
        if (!selection) return;
        if (!requestId) requestId = makeRequestId();
        const epoch = sessionEpoch;
        const form = new FormData();
        form.append("image", capturedBlob, "kiosk.jpg");
        form.append("style", styleSel.value);
        if (BRAND_OPTIONS.length) form.append("brand", selectedBrand());
        if (selection.background) form.append("background", selection.background);
        form.append("channel", selection.channel);
        form.append(selection.channel === "email" ? "email" : "phone", selection.destination);
        form.append("kiosk", "1");
        form.append("locale", LOCALE);
        form.append("event", EVENT_NAME);
        form.append("requestId", requestId);
        // Version 2 covers public display of both the selfie and portrait.
        form.append("consent", "2");
        if (selection.channel === "whatsapp") form.append("whatsappOptIn", "1");

        state = "upload";
        confirmBtn.disabled = true;
        retakeBtn.disabled = true;
        show("cancelBtn");
        abortReason = "";
        uploadController = new AbortController();
        setStatus("uploading");
        const timeout = setTimeout(() => {
            abortReason = "timeout";
            uploadController.abort();
        }, UPLOAD_TIMEOUT_MS);
        try {
            const response = await fetch("/api/generate", {
                method: "POST",
                body: form,
                signal: uploadController.signal,
                credentials: "same-origin",
                cache: "no-store",
            });
            const body = await response.json().catch(() => ({}));
            if (epoch !== sessionEpoch) return;
            if (!response.ok || typeof body.filePrefix !== "string") {
                const errorKey = apiErrorKey(response.status, body.code);
                if (errorKey === "kioskSessionExpired" || errorKey === "eventChanged"
                    || errorKey === "submissionConflict") showSessionExpired(errorKey);
                else setStatus(errorKey, { status: response.status }, true);
                return;
            }
            requestId = null;
            showSubmitted(selection.channel);
        } catch {
            if (epoch !== sessionEpoch) return;
            setStatus(abortReason ? "uploadUnconfirmed" : "networkFailed", null, true);
        } finally {
            clearTimeout(timeout);
            if (epoch !== sessionEpoch) return;
            uploadController = null;
            if (state === "upload") {
                state = "review";
                confirmBtn.disabled = false;
                retakeBtn.disabled = false;
                hide("cancelBtn");
                scheduleIdle();
            }
        }
    }

    function showSubmitted(channel) {
        stopCamera();
        clearPreview();
        clearGuestInputs();
        state = "done";
        clearTimeout(idleTimer);
        hide("stage");
        hide("review-panel");
        hide("controls-capture");
        hide("status");
        const methodKey = channel === "whatsapp" ? "queuedForWhatsapp"
            : channel === "email" ? "queuedForEmail" : "queuedForSms";
        $("done-detail").textContent = [
            KIOSK_COPY.generatingNow,
            KIOSK_COPY[methodKey],
            KIOSK_COPY.photoBookAfterComplete,
        ].join(" ");
        show("done-card");
        $("done-title").focus();
        clearTimeout(doneTimer);
        doneTimer = setTimeout(() => resetAll(), DONE_RESET_MS);
    }

    function cancelUpload() {
        if (!uploadController) return;
        abortReason = "cancel";
        uploadController.abort();
    }

    startBtn.addEventListener("click", startCamera);
    snapBtn.addEventListener("click", snap);
    retakeBtn.addEventListener("click", retake);
    confirmBtn.addEventListener("click", generate);
    cancelBtn.addEventListener("click", cancelUpload);
    againBtn.addEventListener("click", () => resetAll());
    styleSel.addEventListener("change", updateBackground);
    brandSel.addEventListener("change", updateBackground);
    for (const radio of document.querySelectorAll('input[name="deliveryChannel"]')) {
        radio.addEventListener("change", updateDelivery);
    }
    for (const eventName of ["pointerdown", "keydown", "input", "change", "touchstart"]) {
        document.addEventListener(eventName, noteActivity, { passive: true });
    }
    window.addEventListener("beforeunload", () => {
        if (uploadController) uploadController.abort();
        stopCamera();
        clearPreview();
    });

    resetAll();
})();
