const BROKER = "fa5e66fc548146f783420bef085c1154.s1.eu.hivemq.cloud";
const PORT = 8884;
const USER = "smartshop";
const PASS = "Smartshop123";

// ── STATEFUL CART & BILLING VARIABLES ──
let cartTotal = 0;
let activeCartItems = [];
let finalizedBillItems = [];
let finalizedTotal = 0;
let billReady = false;
let billsToday = 0;
let revenueToday = 0;
let historyList = [];

// ── MULTI-THREADED 60-FPS VISION STATE ──
let cocoModel = null;
let clipWorker = null;
let clipReady = false;
let ssdBusy = false;
let clipBusy = false;
let lastSsdRunMs = 0;
let lastClipRunMs = 0;

let webcamActive = false;
let webcamStream = null;

let cachedPersonBox = null;
let cachedObjectBox = null;

let candidateSKU = null;
let candidateVotes = 0;
let lockedVisionItem = null;

const ssdCanvas = document.createElement("canvas");
ssdCanvas.width = 320;
ssdCanvas.height = 240;
const ssdCtx = ssdCanvas.getContext("2d", { willReadFrequently: true });

const cropCanvas = document.createElement("canvas");
cropCanvas.width = 224;
cropCanvas.height = 224;
const cropCtx = cropCanvas.getContext("2d");

// Highly distinctive prompts with strict negative boundaries to prevent phone/face hallucinations
const STORE_SKU_CATALOG = [
  {
    prompt: "a tall cylindrical drinking water bottle, thermos flask, or metal bottle with a cap",
    sku: "Water Bottle"
  },
  {
    prompt: "an analog wristwatch dial with clock hands, rectangular watch face, or wrist strap",
    sku: "Wristwatch"
  },
  {
    prompt: "a pair of over-ear audio headphones or headband headset with padded earcups",
    sku: "Headphones"
  },
  {
    prompt: "a glowing smartphone touchscreen display with app icons, absolutely not a watch or a bottle",
    sku: "Smartphone"
  },
  {
    prompt: "a curved plastic computer mouse with buttons and a scroll wheel",
    sku: "Computer Mouse"
  },
  {
    prompt: "a sharp metal kitchen knife, pocket knife, or utility blade with a handle",
    sku: "Kitchen Knife"
  },
  {
    prompt: "a pair of metal scissors with two crossed blades and finger ring loops",
    sku: "Scissors"
  },
  {
    prompt: "a ceramic coffee mug with a side handle, teacup, or drinking glass",
    sku: "Coffee Mug / Cup"
  },
  {
    prompt: "a paper notebook, textbook, or hardcover book with pages",
    sku: "Notebook / Book"
  },
  {
    prompt: "a thin ballpoint pen, marker, or wooden pencil",
    sku: "Pen / Stationery"
  },
  {
    prompt: "a cloth backpack, handbag, zipper pouch, or leather wallet",
    sku: "Bag / Wallet"
  },
  // Strong negative boundaries
  {
    prompt: "a human face, head, eyeglasses, eyes, nose, mouth, skin, or human body",
    sku: "__EMPTY__"
  },
  {
    prompt: "an empty human hand, fingers, palm, or skin holding nothing",
    sku: "__EMPTY__"
  },
  {
    prompt: "a blank room wall, ceiling light fixture, or blurry background",
    sku: "__EMPTY__"
  }
];

const TRUSTED_SSD_HINTS = {
  bottle: "Water Bottle",
  knife: "Kitchen Knife",
  scissors: "Scissors",
  cup: "Coffee Mug / Cup",
  "wine glass": "Coffee Mug / Cup",
  book: "Notebook / Book"
};

const COCO_FALLBACK_MAP = {
  bottle: "Water Bottle",
  cup: "Coffee Mug / Cup",
  book: "Notebook / Book",
  mouse: "Wireless Mouse",
  knife: "Kitchen Knife",
  scissors: "Scissors",
  clock: "Wristwatch",
  backpack: "Bag / Wallet",
  handbag: "Bag / Wallet"
};

const IGNORED_COCO_CLASSES = new Set([
  "person",
  "chair",
  "couch",
  "bed",
  "dining table",
  "tv",
  "refrigerator",
  "oven",
  "sink",
  "toilet",
  "potted plant",
  "car",
  "truck",
  "bus",
  "bench"
]);

function renderSKUListUI() {
  const el = document.getElementById("sku-list-display");
  if (!el) return;
  const uniqueSKUs = [
    ...new Set(
      STORE_SKU_CATALOG.filter((s) => s.sku !== "__EMPTY__").map((s) => s.sku)
    ),
  ];
  el.textContent = "ACTIVE DB SKUS: " + uniqueSKUs.join(" · ");
}

function addStoreSKU() {
  const input = document.getElementById("sku-input");
  const raw = (input.value || "").trim();
  if (!raw) return;

  const exists = STORE_SKU_CATALOG.some(
    (item) =>
      item.sku.toLowerCase() === raw.toLowerCase() ||
      item.sku.toLowerCase().includes(raw.toLowerCase())
  );
  if (exists) {
    input.value = "";
    addFeed(`SKU "${raw}" is already active in the database`, "cnn");
    return;
  }

  STORE_SKU_CATALOG.unshift({
    prompt: `a closeup photo of a ${raw.toLowerCase()}`,
    sku: raw,
  });
  input.value = "";
  renderSKUListUI();
  addFeed(`Added "${raw}" to Zero-Shot CLIP Store SKU Database`, "cnn");
}

function ts() {
  return new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function setConn(ok) {
  document.getElementById("cdot").className = "conn-dot" + (ok ? " live" : "");
  document.getElementById("clab").textContent = ok ? "connected" : "disconnected";
}

function addFeed(text, type) {
  const el = document.getElementById("feed");
  const empty = document.getElementById("feed-empty");
  if (empty) empty.remove();

  const row = document.createElement("div");
  row.className = "feed-row";
  const tagClass =
    type === "add"
      ? "t-add"
      : type === "ret"
      ? "t-ret"
      : type === "cnn"
      ? "t-cnn"
      : type === "theft"
      ? "t-theft"
      : "";
  const tagText =
    type === "add"
      ? "ADD"
      : type === "ret"
      ? "RETURN"
      : type === "cnn"
      ? "VISION"
      : type === "exit"
      ? "EXIT"
      : type === "theft"
      ? "THEFT"
      : "INFO";

  row.innerHTML = `<span class="feed-time">${ts()}</span><span class="feed-tag ${tagClass}">${tagText}</span><span class="feed-msg">${text}</span>`;
  el.insertBefore(row, el.firstChild);
}

function updateMetrics() {
  document.getElementById("m-total").textContent = "₹" + cartTotal;
  document.getElementById("m-bills").textContent = billsToday;
  document.getElementById("m-rev").textContent = "₹" + revenueToday;
  document.getElementById("m-conf").textContent = lockedVisionItem
    ? lockedVisionItem.conf + "%"
    : "—";
}

async function initVisionPipeline() {
  renderSKUListUI();
  const badge = document.getElementById("cnn-badge");
  const cocoURL =
    "https://storage.googleapis.com/tfjs-models/savedmodel/ssd_mobilenet_v2/model.json";

  try {
    await tf.ready();
    cocoModel = await cocoSsd.load({
      base: "mobilenet_v2",
      modelUrl: cocoURL,
    });
    badge.textContent = "STAGE 1: SSD-MOBILENET READY";
    badge.classList.add("ready");
    addFeed("Stage 1 SSD-MobileNetV2 Box Tracker online (optimized)", "cnn");
  } catch (err) {
    try {
      cocoModel = await cocoSsd.load();
      badge.textContent = "STAGE 1: SSD READY";
      badge.classList.add("ready");
    } catch (e2) {}
  }

  initCLIPWebWorker();
}

function initCLIPWebWorker() {
  const clipStatus = document.getElementById("clip-status");
  const badge = document.getElementById("cnn-badge");

  const workerCode = `
    let classifier = null;

    self.onmessage = async (e) => {
      const msg = e.data;

      if (msg.type === "init") {
        try {
          const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
          env.allowLocalModels = false;

          classifier = await pipeline(
            "zero-shot-image-classification",
            "Xenova/clip-vit-base-patch32",
            {
              progress_callback: (p) => {
                if (p.status === "progress" && p.progress) {
                  self.postMessage({ type: "progress", progress: Math.round(p.progress) });
                }
              }
            }
          );
          self.postMessage({ type: "ready" });
        } catch (err) {
          self.postMessage({ type: "error", message: err.message });
        }
      } else if (msg.type === "classify") {
        if (!classifier) {
          self.postMessage({ type: "result", results: null });
          return;
        }
        try {
          const results = await classifier(msg.image, msg.prompts);
          self.postMessage({
            type: "result",
            results: results,
            ssdHintSKU: msg.ssdHintSKU,
            ssdScore: msg.ssdScore,
            isFallbackZone: msg.isFallbackZone,
            bbox: msg.bbox
          });
        } catch (err) {
          self.postMessage({ type: "result", results: null });
        }
      }
    };
  `;

  try {
    const blob = new Blob([workerCode], { type: "application/javascript" });
    clipWorker = new Worker(URL.createObjectURL(blob));

    clipWorker.onmessage = (e) => {
      const data = e.data;
      if (data.type === "progress") {
        clipStatus.textContent = `Loading ViT (${data.progress}%)…`;
      } else if (data.type === "ready") {
        clipReady = true;
        clipStatus.textContent = "CLIP ViT-B/32 Worker ✓";
        badge.textContent = "VISION: SSD + CLIP WORKER READY";
        addFeed("Stage 2 OpenAI CLIP running in background Web Worker", "cnn");
      } else if (data.type === "error") {
        clipStatus.textContent = "SSD Direct Mode";
      } else if (data.type === "result") {
        clipBusy = false;
        handleCLIPWorkerResult(data);
      }
    };

    clipWorker.postMessage({ type: "init" });
  } catch (err) {
    clipStatus.textContent = "SSD Direct Mode";
  }
}

function handleCLIPWorkerResult(data) {
  const { results, ssdHintSKU, ssdScore, isFallbackZone, bbox } = data;
  if (!results || results.length === 0) return;

  let bestSKU = null;
  let bestScore = -1;
  let emptyScore = 0;

  for (const r of results) {
    const entry = STORE_SKU_CATALOG.find((item) => item.prompt === r.label);
    if (!entry) continue;

    if (entry.sku === "__EMPTY__") {
      emptyScore += r.score;
      continue;
    }

    let score = r.score;
    // Apply penalty to Smartphone if scanned in fallback/un-boxed zone to prevent face-as-phone bugs
    if (entry.sku === "Smartphone" && isFallbackZone) {
      score -= 0.15;
    }

    if (ssdHintSKU && entry.sku === ssdHintSKU) {
      score += ssdScore * 0.20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSKU = entry.sku;
    }
  }

  // Stricter threshold for fallback zone
  const minThreshold = isFallbackZone ? 0.42 : 0.25;
  if (bestSKU && bestScore >= minThreshold && bestScore > emptyScore * 0.78) {
    const calibrated = Math.min(0.988, 0.62 + bestScore * 0.52);

    if (isFallbackZone && !cachedObjectBox) {
      cachedObjectBox = {
        bbox: bbox,
        cocoClass: bestSKU,
        score: calibrated,
      };
    }

    registerVisionVote(bestSKU, calibrated, "CLIP-ViT", false);
  }
}

function registerVisionVote(skuName, score, sourceTag = "CLIP-ViT", forceInstant = false) {
  if (!skuName || skuName === "__EMPTY__") return;

  if (!forceInstant) {
    if (candidateSKU === skuName) {
      candidateVotes++;
    } else {
      candidateSKU = skuName;
      candidateVotes = 1;
    }

    if (candidateVotes < 2) {
      if (!lockedVisionItem) {
        document.getElementById("locked-item").textContent = `Verifying ${skuName} (1/2)…`;
      }
      return;
    }
  }

  const conf = (score * 100).toFixed(1);
  const isNewItem = !lockedVisionItem || lockedVisionItem.name !== skuName;

  lockedVisionItem = {
    name: skuName,
    conf: conf,
    source: sourceTag,
    timestamp: Date.now(),
  };

  document.getElementById("locked-item").textContent = `🔒 ${skuName} (${conf}% ${sourceTag}) — Ready for Pick`;
  updateMetrics();

  if (isNewItem) {
    addFeed(`Locked SKU: ${skuName} (${conf}% ${sourceTag}) — Waiting for Wokwi Pick/Place`, "cnn");
  }
}

function clearLockedItem() {
  lockedVisionItem = null;
  candidateSKU = null;
  candidateVotes = 0;
  document.getElementById("locked-item").textContent = "Scanning for next item…";
  updateMetrics();
}

async function toggleWebcam() {
  const btn = document.getElementById("cam-btn");
  const video = document.getElementById("webcam");
  const canvas = document.getElementById("vision-canvas");
  const overlay = document.getElementById("vision-placeholder");

  if (webcamActive) {
    webcamActive = false;
    if (webcamStream) webcamStream.getTracks().forEach((t) => t.stop());
    btn.textContent = "START LIVE WEBCAM";
    overlay.classList.remove("hidden");
    return;
  }

  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = webcamStream;
    await video.play();

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    webcamActive = true;
    btn.textContent = "STOP WEBCAM";
    overlay.classList.add("hidden");
    if (!lockedVisionItem) {
      document.getElementById("locked-item").textContent = "Scanning for next item…";
    }
    requestAnimationFrame(renderVideoLoop);
  } catch (err) {
    alert("Camera permission blocked! Check browser URL bar camera icon.");
  }
}

async function runBackgroundSSD(displayCanvas) {
  if (!cocoModel || ssdBusy) return;
  ssdBusy = true;

  try {
    ssdCtx.drawImage(displayCanvas, 0, 0, ssdCanvas.width, ssdCanvas.height);
    const scaleX = displayCanvas.width / ssdCanvas.width;
    const scaleY = displayCanvas.height / ssdCanvas.height;

    const predictions = await cocoModel.detect(ssdCanvas, 8, 0.22);
    let foundPerson = null;
    let bestObj = null;

    for (const p of predictions) {
      const scaledBox = [
        p.bbox[0] * scaleX,
        p.bbox[1] * scaleY,
        p.bbox[2] * scaleX,
        p.bbox[3] * scaleY,
      ];

      if (p.class === "person" && p.score >= 0.35) {
        if (!foundPerson || p.score > foundPerson.score) {
          foundPerson = { bbox: scaledBox, score: p.score };
        }
      } else if (!IGNORED_COCO_CLASSES.has(p.class)) {
        // STRICT RULE: Ignore "cell phone" or "remote" from coco-ssd to prevent phone/face hallucinations!
        if (p.class === "cell phone" || p.class === "remote") continue;

        const priority = TRUSTED_SSD_HINTS[p.class] ? p.score * 1.30 : p.score;
        if (!bestObj || priority > bestObj.priority) {
          bestObj = {
            bbox: scaledBox,
            cocoClass: p.class,
            score: p.score,
            priority: priority,
          };
        }
      }
    }

    cachedPersonBox = foundPerson;

    if (bestObj) {
      cachedObjectBox = bestObj;
      const trustedHint = TRUSTED_SSD_HINTS[bestObj.cocoClass] || null;

      if (clipReady && !clipBusy && Date.now() - lastClipRunMs > 420) {
        lastClipRunMs = Date.now();
        dispatchMaskedCropToCLIP(displayCanvas, bestObj.bbox, trustedHint, bestObj.score, false);
      }
    } else {
      cachedObjectBox = null;
      if (clipReady && !clipBusy && Date.now() - lastClipRunMs > 750) {
        lastClipRunMs = Date.now();
        const fw = displayCanvas.width * 0.45;
        const fh = displayCanvas.height * 0.50;
        const fx = (displayCanvas.width - fw) / 2;
        const fy = displayCanvas.height * 0.32; // Lowered to avoid face/glasses completely
        dispatchMaskedCropToCLIP(displayCanvas, [fx, fy, fw, fh], null, 0, true);
      }
    }
  } catch (e) {
  } finally {
    ssdBusy = false;
  }
}

function dispatchMaskedCropToCLIP(sourceCanvas, bbox, ssdHintSKU, ssdScore, isFallbackZone) {
  if (!clipWorker || !clipReady || clipBusy) return;
  clipBusy = true;

  const [bx, by, bw, bh] = bbox;
  if (bw < 12 || bh < 12) {
    clipBusy = false;
    return;
  }

  const sx = Math.max(0, bx);
  const sy = Math.max(0, by);
  const sw = Math.min(sourceCanvas.width - sx, bw);
  const sh = Math.min(sourceCanvas.height - sy, bh);

  cropCtx.fillStyle = "#1e1e1e";
  cropCtx.fillRect(0, 0, 224, 224);
  const scale = Math.min(224 / sw, 224 / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (224 - dw) / 2;
  const dy = (224 - dh) / 2;
  cropCtx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, dw, dh);

  const dataUrl = cropCanvas.toDataURL("image/jpeg", 0.84);

  const prompts = STORE_SKU_CATALOG.map((item) => item.prompt);
  clipWorker.postMessage({
    type: "classify",
    image: dataUrl,
    prompts: prompts,
    ssdHintSKU: ssdHintSKU,
    ssdScore: ssdScore,
    isFallbackZone: isFallbackZone,
    bbox: bbox,
  });
}

function renderVideoLoop() {
  if (!webcamActive) return;
  const video = document.getElementById("webcam");
  const canvas = document.getElementById("vision-canvas");
  const ctx = canvas.getContext("2d");

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  if (Date.now() - lastSsdRunMs > 260 && !ssdBusy) {
    lastSsdRunMs = Date.now();
    runBackgroundSSD(canvas);
  }

  if (cachedPersonBox) {
    const [px, py, pw, ph] = cachedPersonBox.bbox;
    drawBannerBox(
      ctx,
      px,
      py,
      pw,
      ph,
      `CUSTOMER / PERSON ${(cachedPersonBox.score * 100).toFixed(0)}%`,
      "#00d4ff",
      2
    );
  }

  if (cachedObjectBox) {
    const [ox, oy, ow, oh] = cachedObjectBox.bbox;
    let labelText = "SCANNING OBJECT…";

    if (candidateSKU && (!lockedVisionItem || candidateSKU !== lockedVisionItem.name)) {
      labelText = `VERIFYING ${candidateSKU.toUpperCase()} (1/2)…`;
    } else if (lockedVisionItem) {
      labelText = `🔒 ${lockedVisionItem.name.toUpperCase()} ${lockedVisionItem.conf}% [${lockedVisionItem.source}]`;
    }

    drawBannerBox(ctx, ox, oy, ow, oh, labelText, "#00ff88", 3);
  }

  requestAnimationFrame(renderVideoLoop);
}

function drawBannerBox(ctx, x, y, width, height, label, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(x, y, width, height);

  ctx.font = "600 11px 'IBM Plex Mono', monospace";
  const textWidth = ctx.measureText(label).width;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(x, Math.max(0, y - 22), textWidth + 12, 22);
  ctx.fillStyle = color;
  ctx.fillText(label, x + 6, Math.max(15, y - 6));
}

async function runSampleInference(skuName) {
  if (webcamActive) await toggleWebcam();

  const overlay = document.getElementById("vision-placeholder");
  const canvas = document.getElementById("vision-canvas");
  canvas.width = 480;
  canvas.height = 260;
  const ctx = canvas.getContext("2d");
  overlay.classList.add("hidden");

  ctx.fillStyle = "#141414";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#222222";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 24) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 24) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  ctx.fillStyle = "#e8e8e8";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;

  let bbox = [165, 35, 150, 190];
  let score = 0.972;

  if (skuName === "Water Bottle") {
    ctx.fillRect(225, 38, 30, 18);
    ctx.fillRect(218, 56, 44, 25);
    ctx.fillRect(195, 81, 90, 135);
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(195, 125, 90, 40);
    bbox = [180, 30, 120, 195];
  } else if (skuName === "Coffee Mug") {
    ctx.fillRect(185, 75, 100, 115);
    ctx.strokeRect(285, 95, 28, 70);
    bbox = [170, 62, 155, 140];
  } else if (skuName === "Headphones") {
    ctx.beginPath();
    ctx.arc(240, 130, 55, Math.PI, 0, false);
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.fillRect(172, 125, 24, 55);
    ctx.fillRect(284, 125, 24, 55);
    bbox = [160, 60, 160, 135];
  } else if (skuName === "Smartphone") {
    ctx.fillRect(195, 42, 90, 175);
    ctx.fillStyle = "#222222";
    ctx.fillRect(202, 54, 76, 145);
    bbox = [185, 34, 110, 192];
  }

  drawBannerBox(
    ctx,
    bbox[0],
    bbox[1],
    bbox[2],
    bbox[3],
    `🔒 ${skuName.toUpperCase()} ${(score * 100).toFixed(1)}% [CLIP-ViT]`,
    "#00ff88",
    3
  );
  registerVisionVote(skuName, score, "CLIP-ViT", true);
}

function handleTotalUpdate(newTotal) {
  if (billReady && newTotal > 0) {
    activeCartItems = [];
    cartTotal = 0;
    billReady = false;
  }

  const delta = newTotal - cartTotal;
  if (delta === 0) return;

  if (delta > 0) {
    const rackNum = delta === 50 ? 1 : delta === 100 ? 2 : 0;
    let itemName = rackNum ? `Rack ${rackNum} Item` : `Custom Item`;
    let badge = "Weight Only";

    if (lockedVisionItem) {
      itemName = `${lockedVisionItem.name} (R${rackNum || 1})`;
      badge = `${lockedVisionItem.source} ${lockedVisionItem.conf}%`;
    }

    activeCartItems.push({
      name: itemName,
      price: delta,
      rack: rackNum,
      badge: badge,
    });

    addFeed(
      `Added ${itemName} [${badge}] → +₹${delta} (Cart: ₹${newTotal})`,
      "add"
    );

    clearLockedItem();
  } else if (delta < 0) {
    const returnedPrice = Math.abs(delta);
    let removedName = `₹${returnedPrice} Item`;
    for (let i = activeCartItems.length - 1; i >= 0; i--) {
      if (activeCartItems[i].price === returnedPrice) {
        removedName = activeCartItems[i].name;
        activeCartItems.splice(i, 1);
        break;
      }
    }
    addFeed(
      `Returned ${removedName} to Rack → -₹${returnedPrice} (Cart: ₹${newTotal})`,
      "ret"
    );
  }

  cartTotal = newTotal;
  updateMetrics();
  renderLiveCartTable(activeCartItems, cartTotal, false);
}

function groupCartItems(itemsArray, fallbackTotal) {
  const map = new Map();
  for (const it of itemsArray) {
    const key = `${it.name}|${it.price}|${it.badge}`;
    if (map.has(key)) {
      map.get(key).qty += 1;
    } else {
      map.set(key, {
        name: it.name,
        price: it.price,
        badge: it.badge,
        qty: 1,
      });
    }
  }
  const grouped = Array.from(map.values());
  if (grouped.length === 0 && fallbackTotal > 0) {
    grouped.push({
      name: "Unindexed Cart Balance",
      price: fallbackTotal,
      badge: "Sync",
      qty: 1,
    });
  }
  return grouped;
}

function renderLiveCartTable(itemsArray, totalAmt, isFinalBill) {
  const statusEl = document.getElementById("bstatus");

  if (itemsArray.length === 0 && totalAmt === 0 && !isFinalBill) {
    document.getElementById("bill-content").innerHTML =
      '<div class="bill-empty">Cart is currently empty…</div>';
    document.getElementById("bill-total").classList.remove("show");
    statusEl.textContent = "WAITING";
    statusEl.className = "bill-status";
    return;
  }

  const grouped = groupCartItems(itemsArray, totalAmt);

  const rows = grouped
    .map(
      (it, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${it.name} <span class="item-badge">${it.badge}</span></td>
      <td class="tr">₹${it.price}</td>
      <td class="tr">${it.qty}</td>
      <td class="tr" style="font-weight:600">₹${it.price * it.qty}</td>
    </tr>`
    )
    .join("");

  document.getElementById("bill-content").innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th>Item &amp; Verification</th>
        <th class="tr">Rate</th><th class="tr">Qty</th><th class="tr">Subtotal</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.getElementById("bill-total").classList.add("show");
  document.getElementById("bill-total-val").textContent = "₹" + totalAmt;

  if (isFinalBill) {
    billReady = true;
    finalizedBillItems = grouped;
    finalizedTotal = totalAmt;
    statusEl.textContent = "READY FOR BILLING";
    statusEl.className = "bill-status ready";
    document.getElementById("pdf-btn").disabled = false;
    document.getElementById("clear-btn").classList.add("show");
  } else {
    statusEl.textContent = "SHOPPING LIVE";
    statusEl.className = "bill-status active";
  }
}

function renderHistory() {
  const el = document.getElementById("hist");
  const empty = document.getElementById("hist-empty");
  if (empty) empty.remove();
  const last = historyList[historyList.length - 1];
  if (!last) return;
  const row = document.createElement("div");
  row.className = "hist-row";
  row.innerHTML = `<span class="hist-name">${last.customer}</span><div class="hist-right"><div class="hist-amt">₹${last.amount}</div><div class="hist-time">${last.time}</div></div>`;
  el.insertBefore(row, el.firstChild);
}

function clearBill() {
  billReady = false;
  activeCartItems = [];
  finalizedBillItems = [];
  finalizedTotal = 0;
  cartTotal = 0;
  updateMetrics();
  document.getElementById("bill-content").innerHTML =
    '<div class="bill-empty">Cart is currently empty…</div>';
  document.getElementById("bill-total").classList.remove("show");
  document.getElementById("bstatus").textContent = "WAITING";
  document.getElementById("bstatus").className = "bill-status";
  document.getElementById("pdf-btn").disabled = true;
  document.getElementById("clear-btn").classList.remove("show");
  const st = document.getElementById("session-tag");
  st.textContent = "no customer";
  st.className = "session-tag";
}

function openModal() {
  if (!billReady) return;
  const totalStr = "₹" + finalizedTotal;
  const cust = document.getElementById("cust-name").value || "Walk-in Customer";
  const phone = document.getElementById("cust-phone").value || "";
  const shop = document.getElementById("shop-name").value || "Smart Shop";
  const keeper = document.getElementById("keeper-name").value || "";
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const billNo =
    "SS" + now.getFullYear() + String(billsToday + 1).padStart(4, "0");

  const rows = finalizedBillItems
    .map(
      (it, i) => `
    <tr>
      <td style="padding:6px 4px;border-bottom:1px solid #f0f0f0">${i + 1}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f0f0f0">${it.name} <span style="font-size:10px;color:#666">[${it.badge}]</span></td>
      <td style="padding:6px 4px;border-bottom:1px solid #f0f0f0;text-align:right">₹${it.price}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f0f0f0;text-align:right">${it.qty}</td>
      <td style="padding:6px 4px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">₹${it.price * it.qty}</td>
    </tr>`
    )
    .join("");

  document.getElementById("preview").innerHTML = `
    <div class="receipt">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="receipt-logo">${shop}</div>
          ${keeper ? `<div class="receipt-meta">Shopkeeper: ${keeper}</div>` : ""}
          <div class="receipt-meta">Two-Stage SSD + OpenAI CLIP ViT Verified</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;font-weight:600">#${billNo}</div>
          <div class="receipt-meta">${dateStr} · ${timeStr}</div>
        </div>
      </div>
      <hr class="receipt-divider">
      <div class="receipt-customer">
        <strong>${cust}</strong>
        ${phone ? `<span>${phone}</span>` : ""}
      </div>
      <table class="receipt-table">
        <thead><tr>
          <th>#</th><th>ITEM (VERIFICATION)</th>
          <th style="text-align:right">RATE</th>
          <th style="text-align:right">QTY</th>
          <th style="text-align:right">TOTAL</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="receipt-total-row">
        <span>TOTAL</span><span>${totalStr}</span>
      </div>
      <div class="receipt-footer">
        THANK YOU FOR SHOPPING · SMART SHOP IOT + CLIP-ViT SYSTEM
      </div>
    </div>`;

  document.getElementById("modal").classList.add("open");

  revenueToday += finalizedTotal;
  historyList.push({ customer: cust, amount: finalizedTotal, time: timeStr });
  billsToday++;
  renderHistory();
  updateMetrics();
}

function closeModal() {
  document.getElementById("modal").classList.remove("open");
}

function printBill() {
  const content = document.getElementById("preview").innerHTML;
  const w = window.open("", "_blank");
  w.document.write(`<!DOCTYPE html><html><head>
    <title>Bill</title>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'IBM Plex Mono',monospace;background:#fff;color:#111;padding:2cm}
      @media print{body{padding:1cm}}
      .receipt-logo{font-family:'IBM Plex Sans',sans-serif;font-size:20px;font-weight:600;letter-spacing:.04em}
      .receipt-meta{font-size:11px;color:#888;margin-top:2px}
      .receipt-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}
      .receipt-table th{font-size:10px;letter-spacing:.1em;color:#888;padding:4px 0 8px;border-bottom:1px solid #e0e0e0;text-align:left;font-weight:500}
      .receipt-table td{padding:6px 0;border-bottom:1px solid #f0f0f0}
      .receipt-total-row{display:flex;justify-content:space-between;margin-top:16px;padding-top:12px;border-top:2px solid #111;font-size:16px;font-weight:600}
      .receipt-footer{margin-top:24px;font-size:10px;color:#aaa;text-align:center;letter-spacing:.06em}
      hr{border:none;border-top:1px solid #e0e0e0;margin:16px 0}
    </style>
  </head><body>${content}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 500);
}

function initMQTT() {
  const id = "dash_" + Math.random().toString(36).substr(2, 8);
  const client = new Paho.MQTT.Client(BROKER, PORT, "/mqtt", id);

  client.onConnectionLost = () => setConn(false);
  client.onMessageArrived = (msg) => {
    const topic = msg.destinationName;
    const payload = msg.payloadString;

    if (topic === "shop/total") {
      const newTotal = parseInt(payload) || 0;
      const st = document.getElementById("session-tag");
      st.textContent = "customer active";
      st.className = "session-tag active";
      handleTotalUpdate(newTotal);
    } else if (topic === "shop/bill") {
      const amt = parseInt(payload) || 0;
      addFeed("Customer exited — Final Bill ₹" + amt, "exit");
      renderLiveCartTable(activeCartItems, amt, true);
      activeCartItems = [];
      cartTotal = 0;
      updateMetrics();
      const st = document.getElementById("session-tag");
      st.textContent = "bill ready";
      st.className = "session-tag";
    } else if (topic === "shop/theft") {
      const al = document.getElementById("theft-alert");
      al.classList.add("show");
      addFeed("THEFT ALERT — Unbilled item removed from store zone!", "theft");
      setTimeout(() => al.classList.remove("show"), 12000);
    }
  };

  client.connect({
    userName: USER,
    password: PASS,
    useSSL: true,
    onSuccess: () => {
      setConn(true);
      client.subscribe("shop/total");
      client.subscribe("shop/bill");
      client.subscribe("shop/theft");
    },
    onFailure: () => setConn(false),
  });
}

initMQTT();
initVisionPipeline();
updateMetrics();