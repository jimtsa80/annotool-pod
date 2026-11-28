/* annotool: opt-in "server" mode + training badge/Stop.
 * Local mode (default) is unchanged: this file only adds a badge fed by the local
 * live_trainer_status.json (through a hook in livesync.js) and a "Server" button.
 * In server mode a virtual folder is handed to livesync (AnnoSync.connectHandle), so
 * reviews/rejections/predictions/status/exports follow exactly the same code paths
 * as the local live_sync folder, but go to the anno_server API instead.
 * Must be loaded BEFORE livesync.js (livesync asks AnnoServerMode() at boot).
 */
(function () {
	"use strict";
	var MODE_KEY = "annotool.server.mode";
	var URL_KEY = "annotool.server.url";
	var TOKEN_KEY = "annotool.server.token";
	var USER_KEY = "annotool.server.user";
	var FAM_KEY = "annotool.server.family";
	var QUEUE_KEY = "annotool.server.queue";
	var PUSHED_PREFIX = "annotool.server.pushed:";
	var LIVE_FILE = "annotool_live.json";
	var PRED_FILE = "annotool_predictions.json";
	var STATUS_FILE = "live_trainer_status.json";
	var EXPORT_REQUEST_FILE = "annotool_export_request.json";
	var EXPORT_RESPONSE_FILE = "annotool_export_response.json";
	var VNAME = "server";
	/* on github.io the default server is the RunPod pod; served locally it stays the local anno_server */
	var DEFAULT_URL = /\.github\.io$/.test(location.hostname) ? "https://09u3eun0nejfkv-8000.proxy.runpod.net" : "http://127.0.0.1:8765";
	/* pod "waker": a tiny Cloudflare Worker that can ONLY start the pod when it is stopped (needs the wake key) */
	var WAKER_URL = /\.github\.io$/.test(location.hostname) ? "https://anno-waker.jimtsa80.workers.dev" : "";
	var WAKE_KEY = "annotool.wake.key";
	var WINDOW = 400;
	var RED_AFTER_MS = 10 * 60 * 1000;
	var STATUS_MS = 4000;
	var PRED_MS = 8000;
	var UPLOAD_BATCH = 12;

	function ls(key, value) {
		try {
			if (arguments.length === 1) return localStorage.getItem(key);
			if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
		} catch (e) {}
		return null;
	}
	function isServer() { return ls(MODE_KEY) === "server"; }
	/* invite link  .../annotool-pod/#wake=KEY  stores the wake key once, then removes it from the address bar */
	(function () {
		var m = /[#&]wake=([A-Za-z0-9_-]{16,128})/.exec(location.hash || "");
		if (!m) return;
		ls(WAKE_KEY, m[1]);
		try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
	})();
	window.AnnoServerMode = isServer;

	function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
	function el(tag, attrs, text) {
		var e = document.createElement(tag), k;
		for (k in (attrs || {})) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
		if (text != null) e.textContent = text;
		return e;
	}
	function toast(text, type) {
		if (window.Noty) new Noty({ type: type || "info", theme: "mint", layout: "topRight", text: text, timeout: 3500 }).show();
	}

	/* ------------------------------------------------------------------ badge + Stop */
	var TrainUi = (function () {
		var badge, stopBox, stopMsg, stopBtn, lastVersion = null, newUntil = 0, newTimer = null, view = null, stopFn = null;
		function ensure() {
			if (badge && document.body.contains(badge)) return true;
			var host = document.getElementById("liveTrainer");
			var before = document.getElementById("liveModelChoiceLabel");
			if (!host) return false;
			badge = el("span", { id: "trainBadge", hidden: "hidden", title: "κατάσταση εκπαίδευσης (δεν σταματάει τη δουλειά)" });
			stopBox = el("span", { id: "trainStopBox", hidden: "hidden" });
			stopMsg = el("span", { id: "trainStopMsg" });
			stopBtn = el("button", { type: "button", id: "trainStopBtn", title: "σταματάει την εκπαίδευση που τρέχει τώρα" }, "Διακοπή");
			stopBox.appendChild(stopMsg);
			stopBox.appendChild(stopBtn);
			stopBtn.addEventListener("click", function () {
				if (!stopFn) return;
				stopBtn.disabled = true;
				stopBtn.textContent = "σταματάει…";
				Promise.resolve(stopFn()).catch(function (e) { toast("Διακοπή: " + (e && e.message || e), "error"); })
					.then(function () { setTimeout(function () { stopBtn.disabled = false; stopBtn.textContent = "Διακοπή"; }, 3000); });
				this.blur();
			});
			if (before && before.parentNode === host) { host.insertBefore(badge, before); host.insertBefore(stopBox, before); }
			else { host.appendChild(badge); host.appendChild(stopBox); }
			return true;
		}
		function paint() {
			if (!ensure()) return;
			var v = view, text = "", cls = "";
			if (v && v.state === "training") {
				text = "εκπαίδευση…" + (v.epoch != null && v.epochs ? " epoch " + v.epoch + "/" + v.epochs : "");
				cls = "busy";
			} else if (v && (v.state === "preparing" || v.state === "queued")) {
				text = "ετοιμάζεται νέα εκπαίδευση" + (v.state === "queued" && v.queuePos > 1 ? " (σειρά " + v.queuePos + ")" : "");
				cls = "prep";
			} else if (Date.now() < newUntil) {
				text = "νέο μοντέλο";
				cls = "new";
			}
			badge.textContent = text;
			badge.className = cls;
			if (text) badge.removeAttribute("hidden"); else badge.setAttribute("hidden", "hidden");
			var canStop = !!(v && v.canStop && stopFn);
			if (canStop) {
				stopMsg.textContent = v.state === "training" ? "το μοντέλο εκπαιδεύεται" : "έρχεται εκπαίδευση";
				stopBox.removeAttribute("hidden");
			} else stopBox.setAttribute("hidden", "hidden");
		}
		function update(next, stopper) {
			view = next;
			stopFn = stopper || null;
			if (next && next.version != null) {
				if (lastVersion != null && String(next.version) !== String(lastVersion)) {
					newUntil = Date.now() + 10000;
					clearTimeout(newTimer);
					newTimer = setTimeout(paint, 10100);
				}
				lastVersion = next.version;
			}
			paint();
		}
		function reset() { lastVersion = null; newUntil = 0; view = null; stopFn = null; paint(); }
		return {
			update: update,
			reset: reset,
			// called by livesync.js after it reads live_trainer_status.json (local mode)
			onLocalStatus: function (doc) {
				if (isServer()) return;
				if (!doc) { update(null, null); return; }
				var st = String(doc.state || "").toLowerCase(), state = "idle";
				if (st === "training" || st === "training_family") state = "training";
				else if (st === "waiting_gpu") state = "preparing";
				// the local trainer has no stop request yet, so no Stop button in local mode
				update({ state: state, epoch: doc.epoch, epochs: doc.epochs, version: doc.cycle, canStop: false }, null);
			}
		};
	})();
	window.AnnoTrainUi = TrainUi;

	/* ------------------------------------------------------------------ API + health */
	var health = { state: "off", since: 0, timer: null, delay: 5000, info: null };
	var wake = { active: false, busy: false, nextCheck: 0, warned: false, newPod: false };
	var session = { token: ls(TOKEN_KEY) || "", user: null, families: [] };
	try { session.user = JSON.parse(ls(USER_KEY) || "null"); } catch (e) { session.user = null; }

	function baseUrl() { return String(ls(URL_KEY) || DEFAULT_URL).replace(/\/+$/, ""); }

	function api(method, path, body, opts) {
		opts = opts || {};
		var ctrl = window.AbortController ? new AbortController() : null;
		var t = ctrl ? setTimeout(function () { ctrl.abort(); }, opts.timeout || 20000) : null;
		var headers = {};
		if (session.token && !opts.noAuth) headers.Authorization = "Bearer " + session.token;
		var init = { method: method, headers: headers, signal: ctrl ? ctrl.signal : undefined, cache: "no-store" };
		if (body instanceof FormData) init.body = body;
		else if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
		return fetch(baseUrl() + path, init).then(function (res) {
			if (t) clearTimeout(t);
			if (res.status === 401 && !opts.noAuth) { logoutLocal("η σύνδεση έληξε, κάνε ξανά login"); }
			if (!res.ok) {
				return res.text().then(function (txt) {
					var msg = txt;
					try { msg = JSON.parse(txt).detail || txt; } catch (e) {}
					var err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
					err.status = res.status;
					throw err;
				});
			}
			if (opts.raw) return res;
			var ct = res.headers.get("content-type") || "";
			return ct.indexOf("json") >= 0 ? res.json() : res.text();
		}, function (err) {
			if (t) clearTimeout(t);
			var e = new Error("server μη διαθέσιμος");
			e.network = true;
			markDown();
			throw e;
		});
	}

	function setHealth(state) {
		if (health.state !== state) {
			var was = health.state;
			health.state = state;
			if (state === "waking" && was !== "red") health.since = Date.now();
			if (state === "green") { health.delay = 5000; wake.active = false; wake.newPod = false; kick(); }
			paintPanel();
		}
	}
	function markDown() {
		if (!isServer()) return;
		if (health.state === "green" || health.state === "off") { health.since = Date.now(); setHealth("waking"); }
		scheduleHealth(0);
	}
	function scheduleHealth(ms) {
		clearTimeout(health.timer);
		health.timer = setTimeout(checkHealth, ms == null ? health.delay : ms);
	}
	function checkHealth() {
		if (!isServer()) { setHealth("off"); return; }
		api("GET", "/health", undefined, { noAuth: true, timeout: 8000 }).then(function (h) {
			health.info = h;
			if (h && h.status === "ready") { setHealth("green"); scheduleHealth(20000); }
			else { if (health.state !== "red") setHealth("waking"); grow(); maybeWake(); }
		}, function () {
			if (health.state !== "red") setHealth("waking");
			grow();
			maybeWake();
		});
	}
	function wakeKey() { return String(ls(WAKE_KEY) || "").trim(); }
	function wakeApi(method, path) {
		var ctrl = window.AbortController ? new AbortController() : null;
		var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
		return fetch(WAKER_URL + path, { method: method, headers: { "X-Wake-Key": wakeKey() }, cache: "no-store", signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
			if (t) clearTimeout(t);
			return res.json().then(function (j) { j = j || {}; j._status = res.status; return j; }, function () { return { _status: res.status }; });
		}, function (e) { if (t) clearTimeout(t); throw e; });
	}
	/* the waker may have replaced the pod (old GPU taken): adopt its new proxy URL, but never overwrite a custom/local URL */
	var POD_URL_RE = /^https:\/\/[a-z0-9]{8,20}-\d+\.proxy\.runpod\.net\/?$/;
	function adoptPodUrl(u) {
		if (!u || !POD_URL_RE.test(u)) return false;
		u = u.replace(/\/+$/, "");
		var cur = baseUrl();
		if (u === cur || !(POD_URL_RE.test(cur) || !ls(URL_KEY))) return false;
		ls(URL_KEY, u);
		var inp = document.getElementById("srvUrl");
		if (inp) inp.value = u;
		wake.newPod = true;
		scheduleHealth(0);
		return true;
	}
	/* server not answering: ask the waker; if the pod is stopped, start it and keep polling /health every ~10 s */
	function maybeWake() {
		if (!WAKER_URL || !isServer() || wake.busy || !wakeKey()) return;
		if (document.visibilityState === "hidden" || Date.now() < wake.nextCheck) return;
		wake.busy = true;
		wake.nextCheck = Date.now() + 10000;
		wakeApi("GET", "/status").then(function (st) {
			if (st._status === 401 || st._status === 403) {
				if (!wake.warned) { wake.warned = true; toast("Wake key λάθος — δες στο πάνελ του Server", "warning"); }
				return;
			}
			adoptPodUrl(st.url); /* pod id changed since we last looked: follow it */
			if (st.state === "stopped" || st.state === "gone") {
				wake.active = true;
				paintPanel();
				return wakeApi("POST", "/wake").then(function (w) {
					if (w._status === 429) wake.nextCheck = Date.now() + 30000; /* just started by someone else / rate limited: keep waiting */
					if (w.action === "created") wake.newPod = true; /* old GPU was taken: a new pod is being built (a bit longer) */
					adoptPodUrl(w.url);
					if (w._status === 502 || w.error) wake.nextCheck = Date.now() + 30000;
					paintPanel();
				});
			}
			if (st.state === "starting") wake.active = true;
			else wake.active = st.state === "running" && wake.active; /* running but /health not ready yet: still booting */
			if (!wake.active) paintPanel();
		}).catch(function () {}).then(function () { wake.busy = false; });
	}
	function grow() {
		if (health.state === "waking" && Date.now() - health.since > RED_AFTER_MS) setHealth("red");
		health.delay = Math.min(30000, Math.round(health.delay * 1.4));
		scheduleHealth(wake.active ? 10000 : health.state === "red" ? 30000 : health.delay);
	}
	function online() { return isServer() && health.state === "green"; }

	/* ------------------------------------------------------------------ virtual folder */
	var vfiles = {};       // name -> {text, mtime}
	var vtree = {};        // export sub folders: path -> {name: text}
	var current = { family: ls(FAM_KEY) || "", project: "", doc: null, reviewed: {}, imageCount: 0 };

	function notFound(name) { var e = new Error(name + " not found"); e.name = "NotFoundError"; return e; }
	function putFile(name, text) {
		var prev = vfiles[name];
		if (prev && prev.text === text) return false;
		vfiles[name] = { text: text, mtime: Date.now() + Math.random() };
		return true;
	}
	function fileHandle(name, store) {
		return {
			kind: "file", name: name,
			getFile: function () {
				var f = store[name];
				if (!f) return Promise.reject(notFound(name));
				var text = typeof f === "string" ? f : f.text;
				return Promise.resolve({ name: name, lastModified: typeof f === "string" ? 0 : f.mtime, size: text.length,
					text: function () { return Promise.resolve(text); } });
			},
			createWritable: function () {
				var buf = [];
				return Promise.resolve({
					write: function (chunk) {
						if (typeof chunk === "string") { buf.push(chunk); return Promise.resolve(); }
						return new Blob([chunk]).text().then(function (t) { buf.push(t); });
					},
					close: function () { onWrite(name, buf.join("")); return Promise.resolve(); },
					abort: function () { return Promise.resolve(); }
				});
			}
		};
	}
	function dirHandle(path) {
		var store = path ? (vtree[path] = vtree[path] || {}) : null;
		return {
			kind: "directory", name: path ? path.split("/").pop() : VNAME,
			queryPermission: function () { return Promise.resolve(isServer() ? "granted" : "denied"); },
			requestPermission: function () { return Promise.resolve(isServer() ? "granted" : "denied"); },
			getDirectoryHandle: function (part) {
				var next = path ? path + "/" + part : part;
				return Promise.resolve(dirHandle(next));
			},
			getFileHandle: function (name, opts) {
				var create = !!(opts && opts.create);
				if (store) {
					if (!store[name] && !create) return Promise.reject(notFound(name));
					return Promise.resolve(fileHandle(name, store));
				}
				var ready = (name === LIVE_FILE && !vfiles[LIVE_FILE]) ? loadServerState() : Promise.resolve();
				return ready.then(function () {
					if (!vfiles[name] && !create) throw notFound(name);
					return fileHandle(name, vfiles);
				});
			}
		};
	}
	var vroot = dirHandle("");

	function onWrite(name, text) {
		if (name === LIVE_FILE) { putFile(name, text); scheduleProcess(text); return; }
		if (name === EXPORT_REQUEST_FILE) { putFile(name, text); handleExport(text); return; }
		putFile(name, text);
	}

	/* ------------------------------------------------------------------ helpers for frames */
	function openProject() {
		if (typeof allAnnotations !== "undefined" && allAnnotations && allAnnotations.project) return String(allAnnotations.project);
		if (typeof prefs !== "undefined" && prefs && prefs.projectName) return String(prefs.projectName);
		return "";
	}
	function frameKeys() { return (typeof imIndices !== "undefined" && imIndices) ? imIndices : []; }
	function frameFile(rel) { return (typeof imAll !== "undefined" && imAll) ? imAll[rel] : null; }
	function projPath(p) { return "/families/" + encodeURIComponent(current.family) + "/projects/" + encodeURIComponent(p || current.project); }
	function famPath() { return "/families/" + encodeURIComponent(current.family); }

	function rejToServer(r) {
		return { brand: r.brand, tpoint: r.tpoint, startPoint: [r.x, r.y], diagPoint: [r.x + r.width, r.y + r.height], confidence: r.confidence == null ? null : r.confidence };
	}
	function rejToLocal(r) {
		var s = r.startPoint || [0, 0], d = r.diagPoint || [0, 0];
		return { brand: r.brand, tpoint: r.tpoint, x: Math.min(s[0], d[0]), y: Math.min(s[1], d[1]), width: Math.abs(d[0] - s[0]), height: Math.abs(d[1] - s[1]), confidence: r.confidence == null ? null : r.confidence };
	}
	function fingerprint(entry, rejected) {
		var anns = (entry && entry.annotations) || [];
		return JSON.stringify([anns.map(function (a) { return [a.brand, a.tpoint, a.startPoint, a.diagPoint, a.hits, a.group]; }),
			(rejected || []).map(function (r) { return [r.brand, r.tpoint, r.startPoint, r.diagPoint]; })]);
	}
	function pushedKey(p) { return PUSHED_PREFIX + baseUrl() + "|" + current.family + "|" + p; }
	function loadPushed(p) { try { return JSON.parse(ls(pushedKey(p)) || "{}") || {}; } catch (e) { return {}; } }
	function savePushed(p, map) { ls(pushedKey(p), JSON.stringify(map)); }

	/* ------------------------------------------------------------------ server state -> live doc */
	var stateLoadedFor = "";
	function loadServerState() {
		var p = openProject();
		if (!p || !current.family || !session.token) return Promise.resolve();
		var key = current.family + "|" + p;
		if (stateLoadedFor === key) return Promise.resolve();
		return api("GET", projPath(p) + "/state").then(function (st) {
			stateLoadedFor = key;
			var rejected = {}, pushed = loadPushed(p), rel, changed = false;
			Object.keys(st.rejected || {}).forEach(function (k) { rejected[k] = (st.rejected[k] || []).map(rejToLocal); });
			// what the server already has does not need to be sent again
			(st.reviewed || []).forEach(function (r) {
				if (pushed[r] == null) { pushed[r] = fingerprint(st.images[r] || { annotations: [] }, (st.rejected || {})[r] || []); changed = true; }
			});
			if (changed) savePushed(p, pushed);
			putFile(LIVE_FILE, JSON.stringify({ project: p, images: st.images || {}, reviewed: st.reviewed || [], rejected: rejected }));
		}, function (err) {
			if (err && err.status === 404) { stateLoadedFor = key; return; }
		});
	}

	/* ------------------------------------------------------------------ live doc -> decisions queue */
	var processTimer = null, processText = null, lastProcess = 0, metaSig = {};
	function scheduleProcess(text) {
		processText = text;
		if (processTimer) return;
		var wait = Math.max(300, 1500 - (Date.now() - lastProcess));
		processTimer = setTimeout(function () {
			processTimer = null;
			lastProcess = Date.now();
			var t = processText;
			processText = null;
			try { processLive(t); } catch (e) { if (window.console) console.warn("server sync", e); }
		}, wait);
	}
	function readQueue() { try { return JSON.parse(ls(QUEUE_KEY) || "[]") || []; } catch (e) { return []; } }
	function writeQueue(q) { ls(QUEUE_KEY, JSON.stringify(q)); paintPanel(); }

	function processLive(text) {
		var doc;
		try { doc = JSON.parse(text); } catch (e) { return; }
		if (!doc || !doc.project || !current.family) return;
		var p = String(doc.project);
		if (p !== current.project) { current.project = p; uploadedRels = {}; lastPredictAt = 0; lastPredictCur = null; }
		current.doc = doc;
		var keys = frameKeys(), index = {};
		for (var i = 0; i < keys.length; i++) index[keys[i]] = i;
		current.imageCount = keys.length;
		var reviewed = {}, images = doc.images || {}, rej = doc.rejected || {}, k;
		(doc.reviewed || []).forEach(function (r) { reviewed[r] = true; });
		var canvas = null;
		for (k in images) if (images[k] && images[k].width) { canvas = [images[k].width, images[k].height]; break; }
		var pushed = loadPushed(p), cand = {}, items = [];
		for (k in reviewed) cand[k] = 1;
		for (k in images) if (images[k] && images[k].annotations && images[k].annotations.length) cand[k] = 1;
		for (k in rej) if (rej[k] && rej[k].length) cand[k] = 1;
		for (k in pushed) cand[k] = 1;
		var done = {};
		for (k in cand) {
			var hasAnn = !!(images[k] && images[k].annotations && images[k].annotations.length);
			var rejs = (rej[k] || []).map(rejToServer);
			var isRev = reviewed[k] || hasAnn || rejs.length;
			if (isRev) done[k] = true;
			var fp, item;
			if (isRev) {
				var entry = images[k] ? JSON.parse(JSON.stringify(images[k])) : null;
				if (!entry) entry = { imageName: k, imageIndex: index[k] != null ? index[k] : 0, width: canvas ? canvas[0] : 0, height: canvas ? canvas[1] : 0, annotations: [], exifdata: {} };
				if (entry.imageIndex == null && index[k] != null) entry.imageIndex = index[k];
				fp = fingerprint(entry, rejs);
				item = { rel: k, entry: entry, rejected: rejs, order: index[k] != null ? index[k] : null };
			} else {
				fp = "U";
				item = { rel: k, unreview: true };
				if (pushed[k] == null) continue;
			}
			if (pushed[k] === fp) continue;
			pushed[k] = fp;
			items.push(item);
		}
		current.reviewed = done;
		var q = readQueue();
		var sig = JSON.stringify([doc.prefs || {}, doc.presets || {}, keys.length]);
		if (metaSig[current.family + "|" + p] !== sig) {
			metaSig[current.family + "|" + p] = sig;
			q.push({ kind: "meta", family: current.family, project: p, body: { image_num: keys.length, prefs: doc.prefs || {}, presets: doc.presets || {}, current: doc.currentImage || null } });
		}
		for (i = 0; i < items.length; i += 300) {
			q.push({ kind: "decisions", family: current.family, project: p, body: { items: items.slice(i, i + 300), current: doc.currentImage || null } });
		}
		if (items.length || q.length) writeQueue(q);
		savePushed(p, pushed);
		items.forEach(function (it) { if (!it.unreview) wantUpload(it.rel, true); });
		planWindow(doc.currentImage);
		kick();
	}

	/* ------------------------------------------------------------------ uploads (only needed frames) */
	var uploadedRels = {}, wantFirst = [], wantLater = [], wantSet = {}, uploading = false, upStats = { done: 0, queued: 0 };
	function wantUpload(rel, first) {
		if (!rel || uploadedRels[rel] || wantSet[rel]) return;
		if (!frameFile(rel)) return;
		wantSet[rel] = true;
		(first ? wantFirst : wantLater).push(rel);
		upStats.queued++;
	}
	function windowRels(cur) {
		var keys = frameKeys(), i = keys.indexOf(cur), out = [], j;
		if (i < 0) i = (typeof imIndex === "number") ? imIndex : 0;
		for (j = i; j < keys.length && out.length < WINDOW; j++) if (!current.reviewed[keys[j]]) out.push(keys[j]);
		for (j = i - 1; j >= 0 && out.length < WINDOW; j--) if (!current.reviewed[keys[j]]) out.push(keys[j]);
		return out;
	}
	var lastWindowCur = null;
	function planWindow(cur) {
		if (!cur || cur === lastWindowCur) return;
		lastWindowCur = cur;
		windowRels(cur).forEach(function (r) { wantUpload(r, false); });
	}
	function sha1Hex(buf) {
		return crypto.subtle.digest("SHA-1", buf).then(function (h) {
			var a = new Uint8Array(h), s = "", i;
			for (i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
			return s;
		});
	}
	function uploadLoop() {
		if (uploading || !online() || !current.family || !current.project) return;
		if (!wantFirst.length && !wantLater.length) return;
		uploading = true;
		var project = current.project, family = current.family, index = {}, keys = frameKeys(), i;
		for (i = 0; i < keys.length; i++) index[keys[i]] = i;
		var batch = (wantFirst.length ? wantFirst : wantLater).splice(0, UPLOAD_BATCH);
		var hadWindow = !wantFirst.length;
		var bufs = {};
		Promise.all(batch.map(function (rel) {
			var f = frameFile(rel);
			if (!f) return null;
			return f.arrayBuffer().then(function (b) { bufs[rel] = b; return sha1Hex(b).then(function (h) { return { rel: rel, sha1: h, order: index[rel] }; }); });
		})).then(function (rows) {
			rows = rows.filter(Boolean);
			if (!rows.length) return;
			return api("POST", "/families/" + encodeURIComponent(family) + "/projects/" + encodeURIComponent(project) + "/frames/check",
				{ items: rows, image_num: keys.length }).then(function (res) {
				var missing = res.missing || [];
				rows.forEach(function (r) { if (missing.indexOf(r.rel) < 0) uploadedRels[r.rel] = true; });
				if (!missing.length) return;
				var fd = new FormData(), meta = [];
				missing.forEach(function (rel) {
					fd.append("files", new Blob([bufs[rel]], { type: "image/jpeg" }), String(rel).split("/").pop() + ".jpg");
					meta.push({ rel: rel, order: index[rel] });
				});
				fd.append("meta", JSON.stringify(meta));
				return api("POST", "/families/" + encodeURIComponent(family) + "/projects/" + encodeURIComponent(project) + "/frames", fd, { timeout: 120000 })
					.then(function () { missing.forEach(function (rel) { uploadedRels[rel] = true; }); });
			});
		}).then(function () {
			batch.forEach(function (rel) { delete wantSet[rel]; });
			upStats.done += batch.length;
			if (hadWindow) maybePredict(false);
		}, function () {
			// put them back; retried when the server is back
			batch.forEach(function (rel) { delete wantSet[rel]; wantUpload(rel, true); upStats.queued--; });
		}).then(function () {
			uploading = false;
			paintPanel();
			if (online()) setTimeout(uploadLoop, 150);
		});
	}

	/* ------------------------------------------------------------------ queue flush */
	var flushing = false;
	function flushQueue() {
		if (flushing || !online() || !session.token) return Promise.resolve();
		var q = readQueue();
		if (!q.length) return Promise.resolve();
		flushing = true;
		var op = q[0];
		var path = "/families/" + encodeURIComponent(op.family) + "/projects/" + encodeURIComponent(op.project);
		var req = op.kind === "meta" ? api("PUT", path, op.body) : api("POST", path + "/decisions", op.body);
		return req.then(function () {
			var q2 = readQueue(); q2.shift(); writeQueue(q2);
		}, function (err) {
			if (err && !err.network && err.status && err.status !== 401 && err.status < 500) {
				var q2 = readQueue(); q2.shift(); writeQueue(q2);
				toast("server: απορρίφθηκε μια αλλαγή (" + err.message + ")", "warning");
			}
		}).then(function () {
			flushing = false;
			if (online() && readQueue().length) return flushQueue();
		});
	}

	/* ------------------------------------------------------------------ status + predictions */
	var statusTimer = null, predTimer = null, lastStatus = null, lastPredictAt = 0, lastPredictCur = null, lastModelVersion = null;
	var lastPred = { n: 0, version: null, at: 0 }, predWait = false;
	var noPredToastAt = 0, inNoPredRegion = false, frameToastTimer = null, predParsed = { text: null, doc: null };
	function mapStatus(s) {
		var raw = s && s.state, nt = (s && s.next_training) || {}, doc;
		var state = raw;
		if (raw === "queued") state = "αναμονή εκπαίδευσης" + (s.queue_position ? " #" + s.queue_position : "");
		else if (raw === "preparing_training") state = "ετοιμάζεται νέα εκπαίδευση";
		else if (raw === "cancelling") state = "σταματάει…";
		/* keep "predicting" so livesync #liveWait (same as local) can show; predWait covers the gap before the server flips */
		else if (raw === "predicting" || (predWait && (raw === "idle" || raw === "ready" || !raw))) state = "predicting";
		doc = {
			schema: 1, state: state, project: current.project || null, cycle: s && s.cycle, epoch: s && s.epoch, epochs: s && s.epochs,
			last_map50: s && s.last_map50, per_class_map50: (s && s.per_class_map50) || {}, updated_at: new Date().toISOString(),
			message: (s && s.message) || "", last_error: (s && s.last_error) || null, model_family: (s && s.family) || current.family || null, model_mode: "server",
			classes: Object.keys((s && s.per_class_map50) || {}).length || null
		};
		if (raw === "idle" && nt.kind === "incremental" && nt.cadence) { doc.reviewed_since_last_cycle = nt.changed_box_frames || 0; doc.threshold = nt.cadence; }
		return doc;
	}
	function pushStatus(s) {
		if (putFile(STATUS_FILE, JSON.stringify(mapStatus(s || lastStatus || { state: predWait ? "predicting" : "idle" }))) && window.AnnoSync && AnnoSync.pollNow) AnnoSync.pollNow();
	}
	function endPredWait() {
		if (!predWait) return;
		predWait = false;
		var s = lastStatus, copy, k;
		if (s && s.state === "predicting") {
			copy = {};
			for (k in s) if (Object.prototype.hasOwnProperty.call(s, k)) copy[k] = s[k];
			copy.state = "idle";
			s = copy;
		}
		pushStatus(s);
		paintPanel();
	}
	function pollStatus() {
		if (!online() || !current.family) return;
		api("GET", famPath() + "/status").then(function (s) {
			lastStatus = s;
			if (s.state === "predicting") predWait = true;
			if (lastModelVersion != null && s.model_version !== lastModelVersion) { predWait = true; pollPredictions(); }
			lastModelVersion = s.model_version;
			pushStatus(s);
			var st = s.state === "training" ? "training" : (s.state === "queued" ? "queued" : (s.state === "preparing_training" ? "preparing" : s.state));
			TrainUi.update({ state: st, epoch: s.epoch, epochs: s.epochs, version: s.model_version, canStop: s.can_stop, queuePos: s.queue_position },
				function () { return api("POST", famPath() + "/stop").then(function (r) { toast("εκπαίδευση: " + (r.result === "cancelling" ? "σταματάει" : r.result)); pollStatus(); }); });
			if (s.state === "error") endPredWait();
			paintPanel();
		}, function () {});
	}
	function maybePredict(force) {
		if (!online() || !current.project || !current.doc) return;
		var cur = current.doc.currentImage || null, keys = frameKeys();
		var moved = lastPredictCur == null ? Infinity : Math.abs(keys.indexOf(cur) - keys.indexOf(lastPredictCur));
		if (!force && moved < 100 && Date.now() - lastPredictAt < 60000) return;
		if (!lastStatus || !lastStatus.has_weights) return;
		lastPredictAt = Date.now();
		lastPredictCur = cur;
		predWait = true;
		pushStatus(lastStatus);
		paintPanel();
		api("POST", projPath() + "/predict", { current: cur }).catch(function () { endPredWait(); });
	}
	function pollPredictions() {
		if (!online() || !current.project) return;
		api("GET", projPath() + "/predictions").then(function (doc) {
			if (!doc || typeof doc !== "object") return;
			var images = doc.images || {}, k, out = {}, n = 0;
			for (k in images) n++;
			// never touch frames the user already reviewed or rejected
			for (k in images) if (!current.reviewed[k]) out[k] = images[k];
			doc.images = out;
			lastPred = { n: n, version: doc.modelVersion || doc.model_version || lastModelVersion, at: Date.now() };
			predWait = false;
			pushStatus(lastStatus);
			if (putFile(PRED_FILE, JSON.stringify(doc)) && window.AnnoSync && AnnoSync.pollNow) AnnoSync.pollNow();
			paintPanel();
		}, function (err) {
			/* keep waiting on blips; hide the bar on real predict failures */
			if (err && !err.network && err.status && err.status !== 404) endPredWait();
			else paintPanel();
		});
	}

	/* ------------------------------------------------------------------ export through the server */
	function handleExport(text) {
		var req;
		try { req = JSON.parse(text); } catch (e) { return; }
		var id = String(req.id || Date.now());
		var annot = (current.doc && current.doc.prefs && current.doc.prefs.AnnotatorName) || "";
		api("GET", famPath() + "/export?project=" + encodeURIComponent(req.project || current.project) + (annot ? "&annotator=" + encodeURIComponent(annot) : ""))
			.then(function (res) {
				var folder = "exports/" + id, store = (vtree[folder] = {});
				(res.files || []).forEach(function (f) { if (f.file) { store[f.file] = f.json_text; store[f.csv] = f.csv_text; } });
				putFile(EXPORT_RESPONSE_FILE, JSON.stringify({ id: id, state: "done", match: res.match, folder: folder,
					files: (res.files || []).map(function (f) { return { project: f.project, file: f.file, csv: f.csv, frames: f.frames, boxes: f.boxes }; }) }));
			}, function (err) {
				putFile(EXPORT_RESPONSE_FILE, JSON.stringify({ id: id, state: "error", message: (err && err.message) || "export failed" }));
			});
	}

	/* ------------------------------------------------------------------ connection to livesync */
	function connectedToServer() {
		var st = window.AnnoSync && AnnoSync.status ? AnnoSync.status() : null;
		return !!(st && st.connected && st.folder === VNAME);
	}
	function ensureLink() {
		if (!window.AnnoSync) return;
		var want = isServer() && session.token && current.family && openProject();
		if (want && !connectedToServer()) {
			stateLoadedFor = "";
			delete vfiles[LIVE_FILE];
			AnnoSync.connectHandle(vroot);
		} else if (!want && connectedToServer()) {
			AnnoSync.disconnect();
		}
	}
	function kick() {
		if (!isServer()) return;
		flushQueue().then(function () { uploadLoop(); });
	}
	function tick() {
		if (!isServer()) return;
		ensureLink();
		if (online()) { flushQueue(); uploadLoop(); }
		paintPanel();
	}

	/* ------------------------------------------------------------------ login / families */
	function logoutLocal(msg) {
		session.token = ""; session.user = null; session.families = [];
		ls(TOKEN_KEY, null); ls(USER_KEY, null);
		if (connectedToServer()) AnnoSync.disconnect();
		if (msg) toast(msg, "warning");
		paintPanel();
	}
	function login(username, password) {
		return api("POST", "/auth/login", { username: username, password: password }, { noAuth: true }).then(function (r) {
			session.token = r.token;
			session.user = { username: r.username, role: r.role };
			session.families = r.families || [];
			ls(TOKEN_KEY, r.token); ls(USER_KEY, JSON.stringify(session.user));
			if (session.families.indexOf(current.family) < 0) setFamily(session.families[0] || "");
			setHealth("green");
			paintPanel();
			tick();
		});
	}
	function refreshMe() {
		if (!session.token || !online()) return;
		api("GET", "/auth/me").then(function (me) {
			session.user = { username: me.username, role: me.role };
			session.families = me.families || [];
			ls(USER_KEY, JSON.stringify(session.user));
			if (current.family && session.families.indexOf(current.family) < 0) setFamily(session.families[0] || "");
			paintPanel();
		}, function () {});
	}
	function setFamily(name) {
		if (name === current.family) return;
		current.family = name || "";
		ls(FAM_KEY, current.family || null);
		current.project = ""; uploadedRels = {}; wantFirst = []; wantLater = []; wantSet = {}; lastWindowCur = null;
		delete vfiles[PRED_FILE]; delete vfiles[STATUS_FILE]; delete vfiles[LIVE_FILE]; stateLoadedFor = "";
		lastModelVersion = null; TrainUi.reset();
		if (connectedToServer()) AnnoSync.disconnect();
		tick();
	}

	/* ------------------------------------------------------------------ side panel UI */
	var ui = {};
	function buildUi() {
		var anchor = document.getElementById("liveSync");
		if (!anchor || document.getElementById("srvMode")) return;
		var wrap = el("span", { id: "srvMode" });
		ui.btn = el("button", { type: "button", id: "srvModeBtn", title: "Local (τοπικός trainer) ή Server" });
		ui.dot = el("i", { id: "srvDot", "aria-hidden": "true" });
		ui.hint = el("i", { id: "srvHint", "aria-hidden": "true" });
		ui.btnText = el("span", { "class": "srv-btn-text" }, "Local");
		ui.btn.appendChild(ui.dot); ui.btn.appendChild(ui.hint); ui.btn.appendChild(ui.btnText);
		ui.panel = el("div", { id: "srvPanel", hidden: "hidden" });
		ui.panel.innerHTML =
			'<div class="srv-row"><b>Λειτουργία</b> <label><input type="radio" name="srvModeSel" value="local"> Local</label> ' +
			'<label><input type="radio" name="srvModeSel" value="server"> Server</label></div>' +
			'<div class="srv-row srv-s"><input id="srvUrl" type="text" placeholder="' + DEFAULT_URL + '" autocomplete="off"></div>' +
			(WAKER_URL ? '<div class="srv-row srv-s" id="srvWakeRow"><input id="srvWake" type="password" placeholder="Βάλε το κλειδί και πάτα Ξύπνα server" autocomplete="off" title="Βάλε το κλειδί και πάτα Ξύπνα server"> <button type="button" id="srvWakeBtn" title="Ξύπνα server">Ξύπνα server</button></div>' : '') +
			'<div class="srv-row srv-s" id="srvHealth"><i class="srv-light"></i> <span id="srvHealthText"></span></div>' +
			'<form class="srv-row srv-s" id="srvLogin"><input id="srvUser" placeholder="username" autocomplete="username"> ' +
			'<input id="srvPass" type="password" placeholder="password" autocomplete="current-password"> <button type="submit">Login</button></form>' +
			'<div class="srv-row srv-s" id="srvWho"></div>' +
			'<div class="srv-row srv-s" id="srvFamRow"><b>Family</b> <select id="srvFam"></select></div>' +
			'<div class="srv-row srv-s" id="srvInfo"></div>' +
			'<div class="srv-row srv-s" id="srvAdminRow" hidden><a id="srvAdmin" href="admin.html" target="_blank">admin panel</a></div>';
		wrap.appendChild(ui.btn);
		document.body.appendChild(ui.panel); /* popover lives on <body>: #title has overflow:hidden and would clip it */
		anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
		function placePanel() {
			var r = ui.btn.getBoundingClientRect(), w = ui.panel.offsetWidth || 260;
			ui.panel.style.top = Math.round(r.bottom + 4) + "px";
			ui.panel.style.left = Math.max(4, Math.min(Math.round(r.left), window.innerWidth - w - 8)) + "px";
		}
		function togglePanel(open) {
			if (open === undefined) open = ui.panel.hidden;
			if (open) { ui.panel.removeAttribute("hidden"); paintPanel(); placePanel(); } else ui.panel.setAttribute("hidden", "hidden");
		}
		ui.btn.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); this.blur(); });
		document.addEventListener("mousedown", function (e) { if (!ui.panel.hidden && !ui.panel.contains(e.target) && !ui.btn.contains(e.target)) togglePanel(false); });
		window.addEventListener("resize", function () { if (!ui.panel.hidden) placePanel(); });
		Array.prototype.forEach.call(ui.panel.querySelectorAll("input[name=srvModeSel]"), function (r) {
			r.addEventListener("change", function () {
				if (!this.checked || this.value === (isServer() ? "server" : "local")) return;
				var go = function () { ls(MODE_KEY, r.value === "server" ? "server" : null); location.reload(); };
				var f = window.AnnoSync && AnnoSync.flush ? AnnoSync.flush() : null;
				Promise.resolve(f).then(go, go);
			});
		});
		var url = document.getElementById("srvUrl");
		url.value = ls(URL_KEY) || DEFAULT_URL;
		url.addEventListener("change", function () { ls(URL_KEY, this.value.trim() || null); health.state = "off"; markDown(); });
		var wk = document.getElementById("srvWake");
		function applyWakeKey() {
			ls(WAKE_KEY, wk && wk.value.trim() || null);
			wake.warned = false;
			wake.nextCheck = 0;
			paintPanel();
			if (health.state !== "green") maybeWake();
		}
		if (wk) {
			wk.value = wakeKey();
			wk.addEventListener("change", applyWakeKey);
			wk.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); applyWakeKey(); } });
		}
		var wkBtn = document.getElementById("srvWakeBtn");
		if (wkBtn) wkBtn.addEventListener("click", function (e) { e.preventDefault(); applyWakeKey(); });
		document.getElementById("srvLogin").addEventListener("submit", function (e) {
			e.preventDefault();
			var u = document.getElementById("srvUser").value.trim(), p = document.getElementById("srvPass").value;
			login(u, p).then(function () { document.getElementById("srvPass").value = ""; },
				function (err) { toast("login: " + ((err && err.message) || err), "error"); });
		});
		document.getElementById("srvFam").addEventListener("change", function () { setFamily(this.value); });
		document.addEventListener("keydown", function (e) { if (e.key === "Escape" && ui.panel && !ui.panel.hidden) ui.panel.setAttribute("hidden", "hidden"); });
		if (isServer()) document.body.className += " anno-server-mode";
	}
	function secs(ms) { var s = Math.floor(ms / 1000); return s < 60 ? s + " s" : Math.floor(s / 60) + "′ " + (s % 60) + "″"; }
	function hintInfo() {
		if (!isServer()) return { cls: "", title: "τοπική λειτουργία (Ζωντανά = τοπικός trainer)" };
		var hs = health.state, st = lastStatus && lastStatus.state;
		if (!session.token && hs === "green") return { cls: "srv-hint-down", title: "⚠️ Η σύνδεση έληξε, κάνε ξανά login" };
		if (WAKER_URL && !wakeKey() && hs !== "green") return { cls: "srv-hint-down", title: "Ο server κοιμάται, βάλε το wake key και πάτα Ξύπνα" };
		if (wake.active && hs !== "green") return { cls: "srv-hint-wait", title: wake.newPod ? "⏳ Ξυπνάει (νέο pod)…" : "⏳ Ξυπνάω τον server, 1–2 λεπτά…" };
		if (hs === "red") return { cls: "srv-hint-down", title: "⚠️ Ο server δεν απαντά" };
		if (hs === "waking" || hs === "off") return { cls: "srv-hint-wait", title: "ξυπνάει… περίμενε" };
		if (st === "training" || st === "training_family" || st === "preparing_training" || st === "queued")
			return { cls: "srv-hint-train", title: "🧠 Εκπαίδευση σε εξέλιξη…" };
		if (st === "predicting" || predWait)
			return { cls: "srv-hint-wait", title: "⏳ Περιμένω προβλέψεις από τον server…" };
		if (lastPred.at)
			return { cls: "srv-hint-ok", title: "✅ Προβλέψεις: " + lastPred.n + " frames (μοντέλο v" + (lastPred.version != null ? lastPred.version : "—") + ")" };
		return { cls: "", title: "server ζωντανός" };
	}
	function paintPanel() {
		if (!ui.btn) return;
		var server = isServer(), hs = health.state, hint = hintInfo();
		ui.btnText.textContent = server ? "Server" : "Local";
		ui.dot.className = server ? ("srv-" + (hs === "off" ? "waking" : hs)) : "";
		ui.hint.className = hint.cls;
		ui.btn.title = hint.title;
		if (ui.panel.hidden) return;
		Array.prototype.forEach.call(ui.panel.querySelectorAll("input[name=srvModeSel]"), function (r) { r.checked = r.value === (server ? "server" : "local"); });
		Array.prototype.forEach.call(ui.panel.querySelectorAll(".srv-s"), function (n) { n.style.display = server ? "" : "none"; });
		if (!server) return;
		var ht = document.getElementById("srvHealthText"), light = ui.panel.querySelector(".srv-light");
		light.className = "srv-light srv-" + (hs === "off" ? "waking" : hs);
		ht.textContent = (WAKER_URL && !wakeKey() && hs !== "green") ? "Ο server κοιμάται, βάλε το wake key και πάτα Ξύπνα" :
			hs === "green" ? (hint.title || "server ζωντανός") : (hs === "red" && !wake.active) ? "μη διαθέσιμος (δουλεύεις κανονικά, οι αλλαγές κρατιούνται)" :
			(wake.active ? (wake.newPod ? "⏳ Ξυπνάει (νέο pod), 2–4 λεπτά… · " : "⏳ Ξυπνάω τον server, 1–2 λεπτά… · ") : "ξυπνάει… περίμενε · ") + secs(Date.now() - (health.since || Date.now()));
		var logged = !!session.token;
		document.getElementById("srvLogin").style.display = logged ? "none" : "";
		document.getElementById("srvWho").innerHTML = "";
		if (logged) {
			var who = document.getElementById("srvWho");
			who.appendChild(document.createTextNode((session.user && session.user.username || "?") + (session.user && session.user.role === "admin" ? " (admin) " : " ")));
			var out = el("a", { href: "#" }, "Αποσύνδεση");
			out.addEventListener("click", function (e) { e.preventDefault(); api("POST", "/auth/logout").catch(function () {}); logoutLocal(); });
			who.appendChild(out);
		}
		var sel = document.getElementById("srvFam");
		var fams = session.families.slice();
		if (current.family && fams.indexOf(current.family) < 0) fams.unshift(current.family);
		var sig = fams.join("\n") + "|" + current.family;
		if (sel._sig !== sig) {
			sel.innerHTML = "";
			fams.forEach(function (f) { var o = el("option", { value: f }, f); if (f === current.family) o.selected = true; sel.appendChild(o); });
			sel._sig = sig;
		}
		document.getElementById("srvFamRow").style.display = logged ? "" : "none";
		var q = readQueue().reduce(function (n, op) { return n + (op.body && op.body.items ? op.body.items.length : 1); }, 0);
		var pending = wantFirst.length + wantLater.length;
		var info = [];
		info.push(q ? "σε αναμονή: " + q + " αλλαγές" : "όλα σταλμένα");
		if (pending) info.push("ανέβασμα εικόνων: " + pending + " ακόμα");
		if (lastStatus && lastStatus.next_training && lastStatus.next_training.note) info.push(lastStatus.next_training.note);
		document.getElementById("srvInfo").textContent = info.join(" · ");
		var adminRow = document.getElementById("srvAdminRow");
		if (logged && session.user && session.user.role === "admin") adminRow.removeAttribute("hidden"); else adminRow.setAttribute("hidden", "hidden");
	}

	/* ------------------------------------------------------------------ no-prediction toast (overlay, never blocks) */
	function frameKey() {
		if (typeof imName === "string" && imName) return imName;
		return (current.doc && current.doc.currentImage) || "";
	}
	function frameIsDecided(key) {
		if (!key) return false;
		if (current.reviewed[key]) return true;
		var doc = current.doc;
		if (doc && doc.reviewed && doc.reviewed.indexOf(key) >= 0) return true;
		if (doc && doc.rejected && doc.rejected[key] && doc.rejected[key].length) return true;
		return false;
	}
	function predHasFrame(key) {
		var f = vfiles[PRED_FILE], doc;
		if (!f || !f.text) return null;
		if (predParsed.text !== f.text) {
			var parsed = null;
			try { parsed = JSON.parse(f.text); } catch (e) { parsed = null; }
			predParsed = { text: f.text, doc: parsed };
		}
		doc = predParsed.doc;
		if (!doc) return null;
		return !!(doc.images && Object.prototype.hasOwnProperty.call(doc.images, key));
	}
	function ensureFrameToast() {
		if (ui.frameToast && document.body.contains(ui.frameToast)) return ui.frameToast;
		ui.frameToast = el("div", { id: "srvFrameToast" });
		document.body.appendChild(ui.frameToast);
		return ui.frameToast;
	}
	function showFrameToast(text) {
		var n = ensureFrameToast();
		n.textContent = text;
		n.className = "on";
		clearTimeout(frameToastTimer);
		frameToastTimer = setTimeout(function () { n.className = ""; }, 2000);
	}
	function watchFramePred() {
		if (!isServer() || !current.family) { inNoPredRegion = false; return; }
		var key = frameKey();
		if (!key || frameIsDecided(key)) { inNoPredRegion = false; return; }
		var has = predHasFrame(key);
		if (has === null) return; /* no predictions file yet — the button already says we're waiting */
		if (has) { inNoPredRegion = false; return; }
		if (inNoPredRegion) return;
		if (Date.now() - noPredToastAt < 5000) return;
		inNoPredRegion = true;
		noPredToastAt = Date.now();
		showFrameToast("⏳ Αυτό το frame δεν έχει ακόμα προβλέψεις — συνέχισε κανονικά");
	}

	/* ------------------------------------------------------------------ boot */
	function boot() {
		buildUi();
		paintPanel();
		if (!isServer()) return;
		markDown();
		setInterval(tick, 2000);
		setInterval(watchFramePred, 200);
		statusTimer = setInterval(pollStatus, STATUS_MS);
		predTimer = setInterval(function () { maybePredict(false); pollPredictions(); }, PRED_MS);
		setInterval(function () { if (health.state !== "green") paintPanel(); }, 1000);
		setInterval(refreshMe, 60000);
		var wasGreen = false;
		setInterval(function () {
			if (online() && !wasGreen) { refreshMe(); kick(); pollStatus(); pollPredictions(); }
			wasGreen = online();
		}, 1000);
		window.addEventListener("online", function () { markDown(); });
	}

	window.AnnoServer = {
		isServer: isServer,
		login: login,
		state: function () { return { health: health.state, family: current.family, project: current.project, queue: readQueue().length, uploads: wantFirst.length + wantLater.length, user: session.user }; },
		_vroot: vroot,
		_process: processLive
	};

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
