"use strict";

// Buildless dashboard client. Polls /api/state every 3s and repaints the panels.
// No framework, no external assets, so it runs from a plain file server offline.

var POLL_MS = 2000;
var pendingDecision = null; // draftId currently being submitted, to lock buttons

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function el(id) {
  return document.getElementById(id);
}

function shortDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var dd = String(d.getDate()).padStart(2, "0");
  var hh = String(d.getHours()).padStart(2, "0");
  var mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "/" + dd + " " + hh + ":" + mi;
}

function shortTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  var hh = String(d.getHours()).padStart(2, "0");
  var mi = String(d.getMinutes()).padStart(2, "0");
  var ss = String(d.getSeconds()).padStart(2, "0");
  return hh + ":" + mi + ":" + ss;
}

function setHealth(ok) {
  var dot = el("health-dot");
  var label = el("health-label");
  dot.className = "dot " + (ok ? "ok" : "down");
  label.textContent = ok ? "live" : "offline";
}

function emptyBlock(text) {
  return '<div class="empty">' + esc(text) + "</div>";
}

function renderDrafts(drafts, learnById) {
  var pending = (drafts || []).filter(function (d) {
    return d.status === "pending_approval";
  });
  el("drafts-count").textContent = String(pending.length);
  var host = el("drafts");
  if (!pending.length) {
    host.innerHTML = emptyBlock("No drafts awaiting approval.");
    return;
  }
  host.innerHTML = pending
    .map(function (d) {
      var media = d.mediaUrl
        ? '<img class="draft-media" src="' +
          esc(d.mediaUrl) +
          '" alt="draft image" onerror="this.style.display=\'none\'" />'
        : "";
      var meta = [];
      meta.push('<span class="chip">' + esc(d.type || "post") + "</span>");
      if (d.slot) meta.push('<span class="chip">' + esc(d.slot) + "</span>");
      if (d.predictedDriver)
        meta.push('<span class="chip">bet: ' + esc(d.predictedDriver) + "</span>");
      if (d.appliedLearningId) {
        var lt = learnById[d.appliedLearningId];
        meta.push(
          '<span class="chip learn">learning: ' +
            esc(lt ? lt.what : d.appliedLearningId) +
            "</span>"
        );
      }
      var rationale = d.rationale
        ? '<p class="loop-draft">' + esc(d.rationale) + "</p>"
        : "";
      return (
        '<div class="draft" data-id="' +
        esc(d.id) +
        '">' +
        '<div class="draft-top">' +
        media +
        '<div class="draft-main">' +
        '<div class="draft-meta">' +
        meta.join("") +
        "</div>" +
        '<p class="draft-text">' +
        esc(d.text) +
        "</p>" +
        rationale +
        "</div>" +
        "</div>" +
        '<div class="actions">' +
        '<button class="btn-approve" data-act="approve">Approve</button>' +
        '<button data-act="edit">Edit</button>' +
        '<button class="btn-reject" data-act="reject">Reject</button>' +
        "</div>" +
        '<div class="editor">' +
        "<textarea>" +
        esc(d.text) +
        "</textarea>" +
        '<div class="actions">' +
        '<button class="btn-approve" data-act="save-edit">Save + post</button>' +
        '<button data-act="cancel-edit">Cancel</button>' +
        "</div>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

function renderSignal(accts) {
  accts = (accts || []).slice().sort(function (a, b) {
    return (b.score || 0) - (a.score || 0);
  });
  el("signal-count").textContent = String(accts.length);
  var host = el("signal");
  if (!accts.length) {
    host.innerHTML = emptyBlock("No scored accounts yet.");
    return;
  }
  host.innerHTML = accts
    .map(function (a) {
      var tier = a.tier === "signal" || a.tier === "watchlist" ? a.tier : "noise";
      var handle = a.handle || "";
      if (handle && handle.charAt(0) !== "@") handle = "@" + handle;
      return (
        '<div class="acct ' +
        tier +
        '">' +
        '<div class="acct-score">' +
        esc(Math.round(a.score || 0)) +
        "</div>" +
        '<div class="acct-body">' +
        '<div class="acct-handle">' +
        esc(handle) +
        "</div>" +
        '<div class="acct-rationale">' +
        esc(a.rationale || a.goal || "") +
        "</div>" +
        "</div>" +
        '<span class="tier-pill ' +
        tier +
        '">' +
        esc(tier) +
        "</span>" +
        "</div>"
      );
    })
    .join("");
}

function renderLearnings(learnings) {
  el("learnings-count").textContent = String((learnings || []).length);
  var host = el("learnings");
  if (!learnings || !learnings.length) {
    host.innerHTML = emptyBlock("No learnings recorded yet.");
    return;
  }
  host.innerHTML = learnings
    .map(function (l) {
      var conf = Math.max(0, Math.min(1, Number(l.confidence) || 0));
      return (
        '<div class="learn-row">' +
        '<div class="learn-head">' +
        '<span class="learn-what">' +
        esc(l.what || "note") +
        "</span>" +
        '<span class="learn-date">' +
        shortDate(l.date) +
        "</span>" +
        "</div>" +
        '<p class="learn-obs">' +
        esc(l.observed) +
        "</p>" +
        '<p class="learn-hyp">' +
        esc(l.hypothesis) +
        "</p>" +
        '<div class="conf-bar"><div class="conf-fill" style="width:' +
        Math.round(conf * 100) +
        '%"></div></div>' +
        "</div>"
      );
    })
    .join("");
}

// Panel 4: show every draft/post that was shaped by a Learning, so the closed
// loop (learn -> next draft) is visible on screen.
function renderLoop(drafts, posts, learnById) {
  var items = [];
  (drafts || []).forEach(function (d) {
    if (d.appliedLearningId) {
      items.push({
        stage: d.status || "draft",
        learningId: d.appliedLearningId,
        text: d.text,
        when: d.updatedAt || d.createdAt,
      });
    }
  });
  (posts || []).forEach(function (p) {
    if (p.appliedLearningId) {
      items.push({
        stage: "posted",
        learningId: p.appliedLearningId,
        text: p.text,
        when: p.postedAt,
      });
    }
  });
  items.sort(function (a, b) {
    return String(b.when || "").localeCompare(String(a.when || ""));
  });
  var host = el("loop");
  if (!items.length) {
    host.innerHTML = emptyBlock(
      "No self-improvement links yet. Once a draft applies a Learning it appears here."
    );
    return;
  }
  host.innerHTML = items
    .slice(0, 12)
    .map(function (it) {
      var l = learnById[it.learningId];
      var quote = l ? l.observed + " -> " + l.hypothesis : it.learningId;
      var preview = it.text ? it.text.slice(0, 140) : "";
      return (
        '<div class="loop-item">' +
        '<div class="loop-flow">' +
        '<span class="loop-node">Learning</span>' +
        '<span class="loop-arrow">-&gt;</span>' +
        '<span class="loop-node">' +
        esc(it.stage) +
        "</span>" +
        "</div>" +
        '<p class="loop-quote">this draft was shaped by Learning: ' +
        esc(quote) +
        "</p>" +
        '<div class="loop-draft">' +
        esc(preview) +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

// Live feed of the loop's internal steps: each subagent tool call (Grok
// x_search, Zero image, Notion read), plus draft/approve/post/learn. This is
// what makes the closing loop visible on stage.
function renderActivity(events) {
  events = events || [];
  var cnt = el("activity-count");
  if (cnt) cnt.textContent = String(events.length);
  var host = el("activity");
  if (!host) return;
  if (!events.length) {
    host.innerHTML = emptyBlock(
      "Idle. Click Run content loop to watch the agents work."
    );
    return;
  }
  host.innerHTML = events
    .slice(0, 40)
    .map(function (e) {
      var kind = e.kind || "info";
      var agent = e.agent
        ? '<span class="ev-agent">' + esc(e.agent) + "</span>"
        : "";
      return (
        '<div class="ev ev-' +
        esc(kind) +
        '">' +
        '<span class="ev-time">' +
        shortTime(e.ts) +
        "</span>" +
        '<span class="ev-loop">' +
        esc(e.loop) +
        "</span>" +
        agent +
        '<span class="ev-detail">' +
        esc(e.detail) +
        "</span>" +
        "</div>"
      );
    })
    .join("");
}

function render(state) {
  var learnings = state.learnings || [];
  var learnById = {};
  learnings.forEach(function (l) {
    learnById[l.id] = l;
  });
  renderActivity(state.events);
  renderDrafts(state.drafts, learnById);
  renderSignal(state.signalAccounts);
  renderLearnings(learnings);
  renderLoop(state.drafts, state.posts, learnById);
  var health = state.health || {};
  setHealth(!!health.ok);
  el("foot-status").textContent =
    "last sync " + shortDate(new Date().toISOString());
}

function submitDecision(draftId, decision, editedText) {
  if (pendingDecision) return;
  pendingDecision = draftId;
  var body = { draftId: draftId, decision: decision };
  if (editedText != null) body.editedText = editedText;
  fetch("/api/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(function () {
      pendingDecision = null;
      poll();
    })
    .catch(function () {
      pendingDecision = null;
    });
}

function onClick(ev) {
  var btn = ev.target.closest ? ev.target.closest("button[data-act]") : null;
  if (!btn) return;
  var card = btn.closest(".draft");
  if (!card) return;
  var id = card.getAttribute("data-id");
  var act = btn.getAttribute("data-act");
  if (act === "approve") {
    submitDecision(id, "approved");
  } else if (act === "reject") {
    submitDecision(id, "rejected");
  } else if (act === "edit") {
    var editor = card.querySelector(".editor");
    if (editor) editor.classList.add("open");
  } else if (act === "cancel-edit") {
    var ed = card.querySelector(".editor");
    if (ed) ed.classList.remove("open");
  } else if (act === "save-edit") {
    var ta = card.querySelector("textarea");
    submitDecision(id, "edited", ta ? ta.value : "");
  }
}

function poll() {
  fetch("/api/state")
    .then(function (r) {
      return r.json();
    })
    .then(render)
    .catch(function () {
      setHealth(false);
    });
}

document.addEventListener("click", onClick);

var runBtn = el("run-loop");
if (runBtn) {
  runBtn.addEventListener("click", function () {
    runBtn.disabled = true;
    runBtn.textContent = "Running...";
    fetch("/api/run-content", { method: "POST" })
      .then(function () {
        poll();
        setTimeout(function () {
          runBtn.disabled = false;
          runBtn.textContent = "Run content loop";
        }, 30000);
      })
      .catch(function () {
        runBtn.disabled = false;
        runBtn.textContent = "Run content loop";
      });
  });
}

poll();
setInterval(poll, POLL_MS);
