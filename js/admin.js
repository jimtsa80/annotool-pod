/* annotool admin panel (talks to anno_server; same login storage as the tool's Server mode) */
(function () {
	"use strict";
	var URL_KEY = "annotool.server.url", TOKEN_KEY = "annotool.server.token", USER_KEY = "annotool.server.user";
	function ls(k, v) { try { if (arguments.length === 1) return localStorage.getItem(k); if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; }
	function base() { return String(ls(URL_KEY) || (/\.github\.io$/.test(location.hostname) ? "https://09u3eun0nejfkv-8000.proxy.runpod.net" : "http://127.0.0.1:8765")).replace(/\/+$/, ""); }
	function $(s) { return document.querySelector(s); }
	function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
	function api(method, path, body) {
		var h = { Authorization: "Bearer " + (ls(TOKEN_KEY) || "") }, init = { method: method, headers: h, cache: "no-store" };
		if (body !== undefined) { h["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
		return fetch(base() + path, init).then(function (r) {
			if (r.status === 401 || r.status === 403) { showLogin(r.status === 403 ? "χρειάζεται λογαριασμός admin" : ""); throw new Error("login"); }
			return r.text().then(function (t) {
				var d; try { d = JSON.parse(t); } catch (e) { d = t; }
				if (!r.ok) throw new Error((d && d.detail) || t);
				return d;
			});
		});
	}
	function fail(e) { if (e && e.message !== "login") alert(e.message || e); }
	function table(el, cols, rows) {
		var html = "<tr>" + cols.map(function (c) { return "<th>" + esc(c[0]) + "</th>"; }).join("") + "</tr>";
		rows.forEach(function (r) { html += "<tr>" + cols.map(function (c) { return "<td>" + (typeof c[1] === "function" ? c[1](r) : esc(r[c[1]])) + "</td>"; }).join("") + "</tr>"; });
		el.innerHTML = html;
	}
	function fmt(t) { return t ? new Date(t).toLocaleString("el-GR") : ""; }
	function showLogin(msg) {
		$("#app").hidden = true; $("#loginBox").hidden = false; $("#url").value = base();
		if (msg) $("#who").textContent = msg;
	}
	$("#loginForm").addEventListener("submit", function (e) {
		e.preventDefault();
		ls(URL_KEY, $("#url").value.trim() || null);
		fetch(base() + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#user").value.trim(), password: $("#pass").value }) })
			.then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || "login"); return d; }); })
			.then(function (d) { ls(TOKEN_KEY, d.token); ls(USER_KEY, JSON.stringify({ username: d.username, role: d.role })); $("#pass").value = ""; start(); })
			.catch(function (e2) { alert(e2.message); });
	});

	var users = [], families = [];
	function loadUsers() {
		return api("GET", "/admin/users").then(function (list) {
			users = list;
			table($("#usersTbl"), [["user", "username"], ["role", "role"], ["families", function (u) { return esc(u.families.join(", ")); }],
				["κατάσταση", function (u) { return u.disabled ? '<span class="bad">disabled</span>' : '<span class="ok">ενεργός</span>'; }],
				["τελευταία δραστηριότητα", function (u) { return esc(fmt(u.last_active)); }],
				["", function (u) {
					return '<button data-act="toggle" data-u="' + esc(u.username) + '">' + (u.disabled ? "Ενεργοποίηση" : "Απενεργοποίηση") + '</button> ' +
						'<button data-act="pw" data-u="' + esc(u.username) + '">Νέο password</button>';
				}]], list);
		});
	}
	$("#usersTbl").addEventListener("click", function (e) {
		var b = e.target.closest("button"); if (!b) return;
		var u = b.getAttribute("data-u"), user = users.filter(function (x) { return x.username === u; })[0];
		if (b.getAttribute("data-act") === "toggle") api("PATCH", "/admin/users/" + encodeURIComponent(u), { disabled: !user.disabled }).then(loadUsers, fail);
		if (b.getAttribute("data-act") === "pw") {
			var p = prompt("Νέο password για " + u + " (≥6 χαρακτήρες)"); if (!p) return;
			api("POST", "/admin/users/" + encodeURIComponent(u) + "/password", { password: p }).then(function () { alert("ok"); }, fail);
		}
	});
	$("#newUser").addEventListener("submit", function (e) {
		e.preventDefault();
		var f = e.target;
		api("POST", "/admin/users", { username: f.username.value.trim(), password: f.password.value, role: f.role.value })
			.then(function () { f.reset(); loadUsers(); }, fail);
	});

	function loadFamilies() {
		return api("GET", "/admin/families").then(function (list) {
			families = list;
			table($("#famTbl"), [["family", "name"], ["μέλη", function (f) { return esc(f.members.join(", ")); }],
				["mAP50", function (f) { return f.map50 == null ? "" : esc(f.map50.toFixed(3)); }], ["κύκλος", "cycle"],
				["reviewed", "reviewed_frames"], ["με κουτιά", "box_frames"], ["απορρίψεις", "rejection_frames"],
				["", function (f) { return '<button data-f="' + esc(f.name) + '">Λεπτομέρειες</button>'; }]], list);
		});
	}
	$("#famTbl").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) famDetail(b.getAttribute("data-f")); });
	function famDetail(name) {
		var f = families.filter(function (x) { return x.name === name; })[0]; if (!f) return;
		var enc = encodeURIComponent(name), box = $("#famDetail");
		box.innerHTML = '<div class="card"><h3>' + esc(name) + '</h3>' +
			'<p><b>Μέλη</b> (ένα ή περισσότερα): <span id="mem"></span> <button id="memSave">Αποθήκευση μελών</button></p>' +
			'<p><button id="famStatus">Status</button> <button id="famStop" class="danger">Διακοπή εκπαίδευσης</button> <span id="famStatusTxt"></span></p>' +
			'<h4>Συνεισφορά ανά χρήστη</h4><table id="contrib"></table>' +
			'<h4>Διαφωνίες (ίδιο καρέ, διαφορετική απόφαση)</h4><table id="dis"></table></div>';
		var mem = $("#mem");
		users.filter(function (u) { return u.role !== "admin"; }).forEach(function (u) {
			var l = document.createElement("label"); l.style.marginRight = "8px";
			l.innerHTML = '<input type="checkbox" value="' + esc(u.username) + '"' + (f.members.indexOf(u.username) >= 0 ? " checked" : "") + "> " + esc(u.username);
			mem.appendChild(l);
		});
		$("#memSave").onclick = function () {
			var names = Array.prototype.map.call(mem.querySelectorAll("input:checked"), function (i) { return i.value; });
			api("PUT", "/admin/families/" + enc + "/members", { usernames: names }).then(function () { loadFamilies(); loadUsers(); alert("ok"); }, fail);
		};
		$("#famStatus").onclick = function () { api("GET", "/families/" + enc + "/status").then(function (s) { $("#famStatusTxt").textContent = s.state + (s.epoch != null ? " epoch " + s.epoch + "/" + s.epochs : "") + " · " + (s.message || "") + " · model v" + s.model_version; }, fail); };
		$("#famStop").onclick = function () { api("POST", "/families/" + enc + "/stop").then(function (r) { $("#famStatusTxt").textContent = "stop: " + r.result; }, fail); };
		api("GET", "/admin/families/" + enc + "/contributions").then(function (rows) {
			table($("#contrib"), [["user", "username"], ["αποφάσεις", "decisions"], ["reviews", "reviews"], ["απορρίψεις", "rejections"],
				["καρέ", "frames"], ["ισχύουν", "frames_in_effect"], ["από", function (r) { return esc(fmt(r.first_at)); }], ["έως", function (r) { return esc(fmt(r.last_at)); }],
				["", function (r) { return '<button class="danger" data-rm="' + esc(r.username) + '">Αφαίρεση συνεισφοράς + retrain</button>'; }]], rows);
			$("#contrib").onclick = function (e) {
				var b = e.target.closest("button[data-rm]"); if (!b) return;
				var u = b.getAttribute("data-rm");
				if (!confirm("Να αφαιρεθούν ΟΛΕΣ οι αποφάσεις του " + u + " στο " + name + " και να ξαναγίνει εκπαίδευση από την αρχή;")) return;
				api("POST", "/admin/families/" + enc + "/remove-contributions", { username: u, retrain: true }).then(function (r) { alert("αφαιρέθηκαν " + r.deactivated_decisions + " αποφάσεις"); famDetail(name); }, fail);
			};
		}, fail);
		api("GET", "/admin/families/" + enc + "/disagreements").then(function (rows) {
			table($("#dis"), [["project", "project"], ["καρέ", "rel"], ["ισχύει του", "winner"],
				["αποφάσεις", function (d) { return d.decisions.map(function (x) { return esc(x.username) + ": " + (x.unreviewed ? "αναίρεση" : esc((x.b || []).join(", ") || "κενό") + (x.r && x.r.length ? " · απέρριψε " + esc(x.r.join(", ")) : "")); }).join("<br>"); }]], rows);
		}, fail);
	}

	function loadActivity() {
		return api("GET", "/admin/activity?days=" + encodeURIComponent($("#actDays").value || 7)).then(function (d) {
			table($("#actTbl"), [["ημέρα", "day"], ["user", "username"], ["αποφάσεις", "decisions"], ["reviews", "reviews"], ["απορρίψεις", "rejections"]], d.per_user_day);
			table($("#evTbl"), [["πότε", function (r) { return esc(fmt(r.created_at)); }], ["user", "username"], ["family", "family"], ["τι", "kind"], ["λεπτομέρειες", "detail"]], d.recent.slice(0, 200));
		});
	}
	$("#actReload").addEventListener("click", function () { loadActivity().catch(fail); });

	function loadJobs() {
		return Promise.all([api("GET", "/admin/jobs"), api("GET", "/status")]).then(function (r) {
			var j = r[0], st = r[1];
			var html = '<div class="card"><b>Εκπαίδευση τώρα:</b> ' + esc(j.training.join(", ") || "—") + ' · <b>ουρά:</b> ' + esc(j.train_queue.join(", ") || "—") +
				' · <b>προβλέψεις σε αναμονή:</b> ' + j.predict_queue.length + ' · <b>idle:</b> ' + esc(j.idle.idle_seconds) + " s (κλείσιμο μετά από " + esc(j.idle.idle_shutdown_minutes) + "′)</div>";
			st.forEach(function (s) {
				html += '<div class="card"><b>' + esc(s.family) + "</b> · " + esc(s.state) + (s.epoch != null ? " epoch " + s.epoch + "/" + s.epochs : "") +
					" · " + esc(s.message || "") + " · mAP50 " + esc(s.last_map50 == null ? "—" : s.last_map50) + " · model v" + esc(s.model_version) +
					(s.next_training && s.next_training.note && s.next_training.note !== s.message ? " · " + esc(s.next_training.note) : "") +
					(s.can_stop ? ' <button class="danger" data-stop="' + esc(s.family) + '">Διακοπή</button>' : "") + "</div>";
			});
			$("#jobs").innerHTML = html;
		});
	}
	$("#jobs").addEventListener("click", function (e) {
		var b = e.target.closest("button[data-stop]"); if (!b) return;
		api("POST", "/families/" + encodeURIComponent(b.getAttribute("data-stop")) + "/stop").then(loadJobs, fail);
	});

	var loaders = { users: loadUsers, families: function () { return loadUsers().then(loadFamilies); }, activity: loadActivity, jobs: loadJobs };
	var tab = "users", jobsTimer = null;
	var IDLE_MS = 10 * 60 * 1000, lastActivity = Date.now(), quietOn = false;
	function tabHidden() { return typeof document.hidden === "boolean" ? document.hidden : document.visibilityState === "hidden"; }
	function quiet() { return tabHidden() || Date.now() - lastActivity >= IDLE_MS; }
	function noteActivity() {
		var was = quietOn || quiet();
		lastActivity = Date.now();
		quietOn = tabHidden();
		if (was && !quietOn && tab === "jobs") loadJobs().catch(function () {});
	}
	document.addEventListener("visibilitychange", function () {
		if (tabHidden()) { quietOn = true; return; }
		lastActivity = Date.now();
		quietOn = false;
		if (tab === "jobs") loadJobs().catch(function () {});
	});
	document.addEventListener("pointerdown", noteActivity, true);
	document.addEventListener("keydown", noteActivity, true);
	document.addEventListener("click", noteActivity, true);
	Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (b) {
		b.addEventListener("click", function () {
			tab = b.getAttribute("data-tab");
			Array.prototype.forEach.call(document.querySelectorAll("nav button"), function (x) { x.classList.toggle("on", x === b); });
			Array.prototype.forEach.call(document.querySelectorAll("[data-pane]"), function (p) { p.hidden = p.getAttribute("data-pane") !== tab; });
			loaders[tab]().catch(fail);
		});
	});

	function start() {
		var u = null; try { u = JSON.parse(ls(USER_KEY) || "null"); } catch (e) {}
		if (!ls(TOKEN_KEY)) { showLogin(); return; }
		api("GET", "/auth/me").then(function (me) {
			if (me.role !== "admin") { showLogin("χρειάζεται λογαριασμός admin"); return; }
			$("#who").textContent = me.username + " (admin)";
			$("#srv").textContent = base();
			$("#loginBox").hidden = true; $("#app").hidden = false;
			loaders[tab]().catch(fail);
			clearInterval(jobsTimer);
			jobsTimer = setInterval(function () {
				var q = quiet();
				if (q) { quietOn = true; return; }
				if (tab === "jobs") loadJobs().catch(function () {});
			}, 4000);
		}, function (e) { if (e.message !== "login") { $("#srv").textContent = "server μη διαθέσιμος: " + base(); showLogin(); } });
	}
	start();
	window.AnnoAdminIdle = {
		ms: IDLE_MS,
		quiet: quiet,
		noteActivity: noteActivity,
		lastActivity: function (t) { if (arguments.length) lastActivity = t; return lastActivity; },
		isOn: function () { return quietOn || quiet(); }
	};
})();
