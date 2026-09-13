(function(){
  if(window.__codegQuotaMounted) return; // 防重复注入（多 webview 共用配置 / 重复 userScript）
  window.__codegQuotaMounted=true;
  // 端点解析：http(s) 页面（Linux 服务端 / 浏览器模式）走同源相对路径；
  // 桌面壳（tauri:// 等自定义协议）无法同源取静态文件，统一走本机 sidecar。
  var IS_WEB=/^https?:$/.test((location.protocol||"").toLowerCase());
  var API_ORIGIN=IS_WEB?(location.protocol+"//"+location.hostname+":3081"):"http://127.0.0.1:3081";
  var JSON_URL=IS_WEB?"/opencode-quota.json":API_ORIGIN+"/quota.json";
  var HIST_URL=IS_WEB?"/opencode-quota-history.jsonl":API_ORIGIN+"/quota-history.jsonl";
  var API_URL="https://opencode.ai/zen/go/v1/usage", REFRESH_MS=60000;
  var LS_ACCT="opencode-quota-account", LS_MODE="opencode-quota-mode", LS_FOLD="opencode-quota-folded"; // mode: left|used
  var ALERT_PCT=80; // 5h 已用超此值 → 红色脉冲 + 浏览器通知

  // ---- i18n：跟随 codeg 语言（cookie codeg.locale，无则跟浏览器） ----
  function lang(){
    try{
      var parts=document.cookie.split(";");
      for(var i=0;i<parts.length;i++){
        var kv=parts[i].trim().split("=");
        if(kv[0]==="codeg.locale"){
          var v=decodeURIComponent(kv.slice(1).join("=")).toLowerCase();
          if(v.indexOf("zh")===0) return "zh";
          return "en";
        }
      }
    }catch(e){}
    try{
      var nav=[].concat(navigator.languages||[]).concat([navigator.language||""]);
      for(var j=0;j<nav.length;j++){ if(nav[j]&&nav[j].toLowerCase().indexOf("zh")===0) return "zh"; }
    }catch(e){}
    return "en";
  }
  var STR={
    zh:{
      quotaTitle:"opencode-go 剩余额度 · 点击刷新",
      foldedTitle:"opencode-go 剩余额度（已折叠）— 点击展开",
      openDetail:"点击展开详情", foldHint:"右键折叠",
      noData:"暂无数据", collecting:"数据收集中…",
      w5h:"5小时", wWeek:"每周", wMonth:"每月",
      pill5h:"5h", pillWeek:"周", pillMonth:"月",
      left:"剩", used:"已用",
      leftPct:"剩余% ⇄", usedPct:"已用% ⇄",
      reset:"已重置",
      updatedAt:"数据更新时间", refresh:"刷新",
      addKey:"添加其他账号 Key",
      aliasPh:"别名，如 小号",
      save:"保存", cancel:"取消", checking:"校验中…",
      needBoth:"别名和 Key 都要填",
      delAcct:"删除该账号",
      usedWord:"已用",
      stale:function(m){ return "数据"+m+"分钟前"; },
      alert:"5小时额度告急",
      alertBody:function(n,p){ return "["+n+"] 5小时已用 "+p+"%，注意用量"; },
      h24:"24小时用量",
      hMax:function(p){ return "最高 "+p+"%"; }
    },
    en:{
      quotaTitle:"opencode-go quota · click to expand",
      foldedTitle:"opencode-go quota (collapsed) — click to expand",
      openDetail:"click to expand", foldHint:"right-click to collapse",
      noData:"No data", collecting:"Collecting…",
      w5h:"5-hour", wWeek:"Weekly", wMonth:"Monthly",
      pill5h:"5h", pillWeek:"W", pillMonth:"M",
      left:"left", used:"used",
      leftPct:"left ⇄", usedPct:"used ⇄",
      reset:"reset",
      updatedAt:"Updated at", refresh:"Refresh",
      addKey:"Add another account key",
      aliasPh:"Alias, e.g. alt",
      save:"Save", cancel:"Cancel", checking:"Checking…",
      needBoth:"Alias and key are both required",
      delAcct:"Delete this account",
      usedWord:"used",
      stale:function(m){ return m+"m stale"; },
      alert:"5-hour quota running low",
      alertBody:function(n,p){ return "["+n+"] 5h used "+p+"%"; },
      h24:"24h usage",
      hMax:function(p){ return "peak "+p+"%"; }
    }
  };
  function S(){ return STR[lang()]||STR.en; }
  // HTML 转义：账号名来自用户输入，拼 innerHTML 前必须过一遍
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }

  function pad(n){ return (n<10?"0":"")+n; }
  function fmtDate(s){ var d=new Date(s); if(lang()==="zh") return (d.getMonth()+1)+"月"+d.getDate()+"日 "+pad(d.getHours())+":"+pad(d.getMinutes()); return (d.getMonth()+1)+"/"+d.getDate()+" "+pad(d.getHours())+":"+pad(d.getMinutes()); }
  function countdown(s){
    var zh=lang()==="zh";
    var d=new Date(s).getTime()-Date.now();
    if(d<=0) return zh?"已重置":"reset";
    var days=Math.floor(d/86400000), h=Math.floor((d%86400000)/3600000), m=Math.floor((d%3600000)/60000);
    if(days>0) return zh?(days+"天"+h+"小时后"):(days+"d "+h+"h left");
    if(h>0) return zh?(h+"小时"+m+"分后"):(h+"h "+m+"m left");
    return zh?(m+"分后"):(m+"m left");
  }
  function delConfirm(n){ return lang()==="zh"?("删除账号 ["+n+"]？"):("Delete account ["+n+"]?"); }
  function delFail(e){ return lang()==="zh"?("删除失败："+e):("Delete failed: "+e); }
  function noDataAcct(e){ return lang()==="zh"?("该账号暂无数据："+e):("No data for this account: "+e); }
  // 数据年龄（分钟）：抓取时间 vs 现在；抓不到返回 null
  function dataAgeMin(){
    try{
      var f=cache&&cache._fetchedAt;
      if(!f) return null;
      return Math.max(0, Math.round((Date.now()-Date.parse(f))/60000));
    }catch(e){ return null; }
  }

  var quotaEl=null, popup=null, cache=null, histCache=null, timerStarted=false;
  function apiBase(){ return API_ORIGIN; }
  function apiToken(){ return localStorage.getItem("codeg_token")||""; }
  async function apiCall(method, path, body){
    var opt={ method:method, headers:{ "X-Codeg-Token": apiToken(), "Content-Type":"application/json" } };
    if(body) opt.body=JSON.stringify(body);
    var r=await fetch(apiBase()+path, opt);
    var j=await r.json().catch(function(){ return { error:"bad response "+r.status }; });
    if(!r.ok) throw new Error(j.error||("http "+r.status));
    return j;
  }
  function getMode(){ return localStorage.getItem(LS_MODE)==="used" ? "used" : "left"; }
  function getAcct(){ return localStorage.getItem(LS_ACCT) || ""; }
  function pickAccount(data){
    if(!data) return null;
    var list=data.accounts||[];
    if(!list.length){
      // 兼容老格式 {usage:{...}}
      if(data.usage) return { name:"", usage:data.usage };
      return null;
    }
    var want=getAcct();
    for(var i=0;i<list.length;i++) if(list[i].name===want && list[i].usage) return list[i];
    for(var j=0;j<list.length;j++) if(list[j].usage) { return list[j]; }
    return list[0];
  }

  // 高用量提醒：超阈值只通知一次（同账号恢复后再超才重报）
  function maybeAlert(acct, rolling){
    if(!acct || rolling==null) return;
    var key="opencode-quota-alerted-"+acct.name;
    if(rolling>=ALERT_PCT){
      quotaEl.classList.add("oq-alert");
      if(localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
      var t=S();
      try{
        if("Notification" in window && Notification.permission==="granted"){
          new Notification(t.alert, { body:t.alertBody(acct.name||"opencode-go", rolling) });
        }
      }catch(e){}
    } else {
      quotaEl.classList.remove("oq-alert");
      try{ localStorage.removeItem(key); }catch(e){}
    }
  }

  function isFolded(){ return localStorage.getItem(LS_FOLD)==="1"; }
  function applyFold(){
    if(!quotaEl) return;
    var t=S();
    var inner=document.getElementById("oq-inline");
    if(isFolded()){
      if(inner) inner.style.display="none";
      quotaEl.style.padding="0 8px";
      quotaEl.title=t.foldedTitle;
    } else {
      if(inner) inner.style.display="";
      quotaEl.style.padding="0 10px";
    }
  }
  function makeQuotaEl(){
    var el=document.createElement("span");
    el.id="opencode-quota-inline";
    el.style.cssText="display:inline-flex;align-items:center;gap:5px;height:24px;border-radius:999px;padding:0 10px;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;user-select:none;color:var(--muted-foreground,#71717a);border:1px solid var(--border,rgba(0,0,0,0.08));background:transparent;flex-shrink:0";
    el.title=S().quotaTitle;
    el.innerHTML='<span style="opacity:.7">⚡</span><span id="oq-inline">…</span>';
    el.addEventListener("click", function(e){
      e.stopPropagation();
      if(isFolded()){ localStorage.setItem(LS_FOLD,"0"); applyFold(); render(cache); return; }
      // 用户手势里顺便申请通知权限（仅当已超阈值，避免打扰）
      try{
        var a=pickAccount(cache);
        if(a&&a.usage&&a.usage.rolling&&a.usage.rolling.percent>=ALERT_PCT
           &&"Notification" in window&&Notification.permission==="default"){ Notification.requestPermission().catch(function(){}); }
      }catch(err){}
      togglePopup();
    });
    // 右键折叠 / 折叠态下右键直接展开（浏览器菜单会被阻止，符合之前约定）
    el.addEventListener("contextmenu", function(e){
      e.preventDefault(); e.stopPropagation();
      if(isFolded()){ localStorage.setItem(LS_FOLD,"0"); }
      else{
        localStorage.setItem(LS_FOLD,"1");
        if(popup) popup.style.display="none";
      }
      applyFold();
    });
    el.addEventListener("mouseenter", function(){ el.style.color="var(--foreground,#111)"; });
    el.addEventListener("mouseleave", function(){ el.style.color="var(--muted-foreground,#71717a)"; });
    return el;
  }

  function numLine(p, mode){
    var t=S();
    if(mode==="used") return "<b>"+p+"%</b> "+t.used;
    return "<b>"+(100-p)+"%</b> "+t.left;
  }

  function render(data){
    if(!quotaEl) return;
    var t=S();
    var acct=pickAccount(data);
    if(!acct || !acct.usage){ var inner0=document.getElementById("oq-inline"); if(inner0) inner0.textContent="—"; return; }
    var mode=getMode(), u=acct.usage, r=u.rolling, w=u.weekly, m=u.monthly;
    if(!r||!w||!m) return;
    var inner=document.getElementById("oq-inline");
    if(!inner) return;
    function dot(p){ var c=p>=90?"#ef4444":p>=70?"#eab308":"#22c55e"; return '<span style="display:inline-block;width:6px;height:6px;border-radius:99px;background:'+c+';margin-right:2px;vertical-align:1px"></span>'; }
    var multi=(cache&&cache.accounts||[]).length>1;
    var prefix=(acct.name && multi) ? '<span style="opacity:.55;max-width:60px;overflow:hidden;text-overflow:ellipsis">'+esc(acct.name)+'</span><span style="opacity:.25">·</span>' : "";
    inner.innerHTML=prefix+
      dot(r.percent)+t.pill5h+' <b>'+(mode==="used"?r.percent:(100-r.percent))+'%</b>'+
      '<span style="opacity:.25;margin:0 5px">·</span>'+
      dot(w.percent)+t.pillWeek+' <b>'+(mode==="used"?w.percent:(100-w.percent))+'%</b>'+
      '<span style="opacity:.25;margin:0 5px">·</span>'+
      dot(m.percent)+t.pillMonth+' <b>'+(mode==="used"?m.percent:(100-m.percent))+'%</b>';
    Array.from(inner.querySelectorAll("b")).forEach(function(b){ b.style.fontWeight="600"; b.style.color="var(--foreground,#111)"; });
    var age=dataAgeMin();
    // 数据过期（>3分钟）药丸变淡，悬停说明
    quotaEl.style.opacity=(age!=null&&age>3)?".45":"";
    quotaEl.title=(acct.name?("["+acct.name+"] "):"")+"5h "+t.usedWord+" "+r.percent+"% | "+t.pillWeek+" "+w.percent+"% | "+t.pillMonth+" "+m.percent+"%"
      +" — "+t.openDetail+"，"+t.foldHint+(age!=null&&age>3?(" · "+t.stale(age)):"");
    maybeAlert(acct, r.percent);
    applyFold();
    if(popup && popup.style.display!=="none") renderPopup();
  }

  // ---- 详情浮层 ----
  function makePopup(){
    var p=document.createElement("div");
    p.id="opencode-quota-popup";
    p.style.cssText="position:fixed;z-index:2147483646;min-width:320px;max-width:360px;background:var(--popover,#fff);color:var(--popover-foreground,#111);border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);padding:12px 14px;font:12px/1.6 ui-sans-serif,system-ui;display:none";
    document.body.appendChild(p);
    if(!document.getElementById("oq-spin-style")){
      var st=document.createElement("style");
      st.id="oq-spin-style";
      st.textContent="@keyframes oq-spin{to{transform:rotate(360deg)}}.oq-spinning{display:inline-block;animation:oq-spin .8s linear infinite}"
        +"@keyframes oq-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55)}50%{box-shadow:0 0 0 4px rgba(239,68,68,0)}}.oq-alert{border-color:#ef4444!important;animation:oq-pulse 1.6s ease-out infinite}";
      document.head.appendChild(st);
    }
    // 点外部关闭
    document.addEventListener("click", function(e){
      if(p.style.display==="none") return;
      if(p.contains(e.target)) return;
      if(quotaEl && quotaEl.contains(e.target)) return;
      p.style.display="none";
    });
    // Esc 关闭
    document.addEventListener("keydown", function(e){
      if((e.key==="Escape"||e.key==="Esc")&&p.style.display!=="none"){ p.style.display="none"; e.stopPropagation(); }
    });
    return p;
  }
  function rowHtml(label, w){
    var mode=getMode();
    var dotC=w.percent>=90?"#ef4444":w.percent>=70?"#eab308":"#22c55e";
    var bar='<span style="display:inline-block;width:64px;height:5px;background:rgba(127,127,127,0.2);border-radius:99px;vertical-align:middle;overflow:hidden"><span style="display:block;width:'+w.percent+'%;height:100%;background:'+dotC+'"></span></span>';
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid var(--border,rgba(0,0,0,0.06))">'
      +'<span style="width:52px;color:var(--muted-foreground,#71717a)">'+label+'</span>'
      +bar
      +'<span style="min-width:76px;text-align:right">'+numLine(w.percent, mode)+'</span>'
      +'<span style="flex:1"></span>'
      +'<span style="text-align:right;color:var(--muted-foreground,#71717a);font-size:11px">'+fmtDate(w.resetsAt)+'<br>'+countdown(w.resetsAt)+'</span>'
      +'</div>';
  }
  // 24h 曲线：当前账号 rolling% 迷你 SVG
  function sparkHtml(acctName){
    var t=S();
    if(!histCache||!histCache.length) return '<div style="opacity:.5;font-size:11px;padding:4px 0">'+t.collecting+'</div>';
    var vals=[];
    for(var i=0;i<histCache.length;i++){
      var pts=histCache[i].a||[];
      for(var j=0;j<pts.length;j++){
        if(pts[j].n===acctName&&pts[j].r!=null){ vals.push(pts[j].r); break; }
      }
    }
    vals=vals.slice(-1440);
    if(vals.length<2) return '<div style="opacity:.5;font-size:11px;padding:4px 0">'+t.collecting+'</div>';
    var W=300,H=40,pad2=2;
    var max=Math.max.apply(null,vals), min=Math.min.apply(null,vals);
    var span=(max-min)||1;
    var d=vals.map(function(v,k){
      var x=(pad2+k/(vals.length-1)*(W-pad2*2)).toFixed(1);
      var y=(H-4-((v-min)/span)*(H-10)).toFixed(1);
      return x+","+y;
    }).join(" ");
    return '<div style="padding:6px 0 2px;border-top:1px solid var(--border,rgba(0,0,0,0.06))">'
      +'<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted-foreground,#71717a);margin-bottom:2px"><span>'+t.h24+'</span><span>'+t.hMax(max)+'</span></div>'
      +'<svg viewBox="0 0 '+W+' '+H+'" style="display:block;width:100%;height:40px"><polyline points="'+d+'" fill="none" stroke="var(--primary,#71717a)" stroke-width="1.5"/></svg></div>';
  }
  function renderPopup(){
    if(!popup || !cache) return;
    var t=S();
    // 先保住表单状态：自动刷新重建 DOM 时不吃掉正在输入的字
    var keepForm=null;
    try{
      var _f=popup.querySelector('[data-form="add"]');
      if(_f&&_f.style.display!=="none"){
        keepForm={ open:true,
          name:(_f.querySelector('[data-in="name"]')||{}).value||"",
          key:(_f.querySelector('[data-in="key"]')||{}).value||"",
          err:((_f.querySelector('[data-form-err]')||{}).textContent||"") };
      }
    }catch(e){}
    var acct=pickAccount(cache);
    if(!acct || !acct.usage) { popup.innerHTML='<div style="opacity:.6">'+t.noData+'</div>'; return; }
    var list=cache.accounts||[];
    var mode=getMode();
    var html="";
    var addBtnHtml='<span data-act="add-form" title="'+t.addKey+'" style="cursor:pointer;font-size:14px;line-height:1;opacity:.6;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center">＋</span>';
    // 账号 Tab
    if(list.length>1){
      html+='<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">';
      list.forEach(function(a){
        var active=a.name===acct.name;
        var bad=!a.usage;
        html+='<span style="display:inline-flex;align-items:center;font-size:11px;border-radius:99px;border:1px solid var(--border,rgba(0,0,0,0.1));'
          +(active?'background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent;font-weight:600;':'opacity:'+(bad?'0.4':'0.75'))
          +'">'
          +'<span data-acct="'+esc(a.name)+'" style="cursor:pointer;padding:3px 4px 3px 10px">'+esc(a.name)+(bad?' ✕':'')+'</span>'
          +'<span data-del="'+esc(a.name)+'" title="'+t.delAcct+'" style="cursor:pointer;padding:3px 8px 3px 2px;opacity:.6">×</span>'
          +'</span>';
      });
      html+='</div>';
    } else if(acct.name){
      html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-weight:650">⚡ '+esc(acct.name)+' <span style="opacity:.45;font-weight:400">opencode-go</span></span><span style="flex:1"></span>'+addBtnHtml+'</div>';
    } else {
      html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-weight:650">⚡ opencode-go</span><span style="flex:1"></span>'+addBtnHtml+'</div>';
    }
    html+='<div data-form="add" style="display:none;margin-bottom:8px;padding:8px;border:1px dashed var(--border,rgba(0,0,0,0.15));border-radius:8px">'
      +'<input data-in="name" placeholder="'+esc(t.aliasPh)+'" maxlength="32" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;padding:4px 8px;border:1px solid var(--border,rgba(0,0,0,0.15));border-radius:6px;background:transparent;color:inherit;outline:none">'
      +'<input data-in="key" placeholder="sk-..." autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin-bottom:6px;font:11px ui-monospace,monospace;padding:4px 8px;border:1px solid var(--border,rgba(0,0,0,0.15));border-radius:6px;background:transparent;color:inherit;outline:none">'
      +'<div data-form-err style="display:none;color:#f87171;font-size:11px;margin-bottom:6px"></div>'
      +'<div style="display:flex;gap:6px;justify-content:flex-end">'
      +'<span data-act="add-cancel" style="cursor:pointer;font-size:11px;padding:2px 10px;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;opacity:.7">'+t.cancel+'</span>'
      +'<span data-act="add-save" style="cursor:pointer;font-size:11px;padding:2px 10px;border-radius:99px;background:var(--primary,#111);color:var(--primary-foreground,#fff)">'+t.save+'</span>'
      +'</div></div>';
    var u=acct.usage;
    if(acct.error || !u.rolling){ html+='<div style="color:#f87171">'+esc(noDataAcct(acct.error||"unknown"))+'</div>'; }
    else{
      html+=rowHtml(t.w5h, u.rolling)+rowHtml(t.wWeek, u.weekly)+rowHtml(t.wMonth, u.monthly);
      html+=sparkHtml(acct.name);
    }
    // 右下角平时只显示抓取时刻 HH:MM；数据过期（>3 分钟）才标 stale
    var age=dataAgeMin();
    var ageTxt="";
    try{
      if(cache&&cache._fetchedAt){ var _fd=new Date(Date.parse(cache._fetchedAt)); ageTxt=pad(_fd.getHours())+":"+pad(_fd.getMinutes()); }
    }catch(e3){}
    if(age!=null&&age>3) ageTxt+=(ageTxt?" · ":"")+t.stale(age);
    html+='<div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px;color:var(--muted-foreground,#71717a)">'
      +'<span data-act="toggle-mode" style="cursor:pointer;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;padding:2px 10px">'+(mode==="used"?t.usedPct:t.leftPct)+'</span>'
      +'<span style="flex:1"></span>'
      +'<span data-act="refresh" title="'+t.refresh+'" style="cursor:pointer;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;line-height:1"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg></span>'
      +'<span title="'+t.updatedAt+'">'+ageTxt+'</span>'
      +'</div>';
    popup.innerHTML=html;
    // 恢复表单状态
    try{
      if(keepForm&&keepForm.open){
        var _f2=popup.querySelector('[data-form="add"]');
        if(_f2){
          _f2.style.display="";
          var _n=_f2.querySelector('[data-in="name"]'), _k=_f2.querySelector('[data-in="key"]'), _e=_f2.querySelector('[data-form-err]');
          if(_n) _n.value=keepForm.name;
          if(_k) _k.value=keepForm.key;
          if(_e&&keepForm.err){ _e.textContent=keepForm.err; _e.style.display=""; }
        }
      }
    }catch(e2){}
    // 绑定
    Array.from(popup.querySelectorAll("[data-acct]")).forEach(function(s){
      s.addEventListener("click", function(e){ e.stopPropagation(); localStorage.setItem(LS_ACCT, s.getAttribute("data-acct")); render(cache); });
    });
    var tm=popup.querySelector('[data-act="toggle-mode"]');
    if(tm) tm.addEventListener("click", function(e){ e.stopPropagation(); localStorage.setItem(LS_MODE, getMode()==="used"?"left":"used"); render(cache); });
    var rf=popup.querySelector('[data-act="refresh"]');
    if(rf) rf.addEventListener("click", function(e){ e.stopPropagation(); rf.classList.add("oq-spinning"); refresh().finally(function(){ rf.classList.remove("oq-spinning"); }); });
    var addBtn=popup.querySelector('[data-act="add-form"]');
    var form=popup.querySelector('[data-form="add"]');
    if(addBtn && form) addBtn.addEventListener("click", function(e){ e.stopPropagation(); form.style.display=""; var ni=form.querySelector('[data-in="name"]'); if(ni) ni.focus(); });
    var cancelBtn=popup.querySelector('[data-act="add-cancel"]');
    if(cancelBtn && form) cancelBtn.addEventListener("click", function(e){ e.stopPropagation(); form.style.display="none"; });
    var saveBtn=popup.querySelector('[data-act="add-save"]');
    if(saveBtn && form) saveBtn.addEventListener("click", function(e){
      e.stopPropagation();
      var nameEl=form.querySelector('[data-in="name"]'), keyEl=form.querySelector('[data-in="key"]');
      var errEl=form.querySelector('[data-form-err]');
      var name=nameEl?nameEl.value.trim():"", key=keyEl?keyEl.value.trim():"";
      if(!name || !key){ if(errEl){ errEl.textContent=t.needBoth; errEl.style.display=""; } return; }
      saveBtn.textContent=t.checking;
      apiCall("POST", "/api/accounts", { name:name, apiKey:key }).then(function(){
        localStorage.setItem(LS_ACCT, name);
        refresh();
      }).catch(function(err){
        if(errEl){ errEl.textContent=String(err.message||err); errEl.style.display=""; }
        saveBtn.textContent=t.save;
      });
    });
    Array.from(popup.querySelectorAll("[data-del]")).forEach(function(x){
      x.addEventListener("click", function(e){
        e.stopPropagation();
        var nm=x.getAttribute("data-del");
        if(!confirm(delConfirm(nm))) return;
        apiCall("DELETE", "/api/accounts?name="+encodeURIComponent(nm)).then(function(){
          if(getAcct()===nm) localStorage.removeItem(LS_ACCT);
          refresh();
        }).catch(function(err){ alert(delFail(err.message||err)); });
      });
    });
  }
  function togglePopup(){
    if(!popup) popup=makePopup();
    if(popup.style.display!=="none"){ popup.style.display="none"; return; }
    fetchHist().finally(function(){
      renderPopup();
      // 定位：药丸上方
      popup.style.display="block";
      var r=quotaEl.getBoundingClientRect();
      var pw=popup.offsetWidth, ph=popup.offsetHeight;
      var left=Math.min(Math.max(8, r.left), window.innerWidth-pw-8);
      var top=r.top-ph-8;
      if(top<8) top=r.bottom+8;
      popup.style.left=left+"px"; popup.style.top=top+"px";
      refresh();
    });
  }

  async function fetchLocal(){ var r=await fetch(JSON_URL+"?t="+Date.now(),{cache:"no-store"}); if(!r.ok) throw new Error("local"); return await r.json(); }
  async function fetchHist(){
    try{
      var r=await fetch(HIST_URL+"?t="+Date.now(),{cache:"no-store"});
      if(!r.ok) return;
      var txt=await r.text();
      var out=[];
      txt.split("\n").forEach(function(line){
        line=line.trim();
        if(!line) return;
        try{ var o=JSON.parse(line); if(o&&o.t) out.push(o); }catch(e){}
      });
      histCache=out.slice(-1500);
    }catch(e){}
  }
  async function fetchDirect(){ var k=localStorage.getItem("opencode-go-api-key"); if(!k) throw new Error("no key"); var r=await fetch(API_URL,{headers:{Authorization:"Bearer "+k}}); if(!r.ok) throw new Error("api"); return await r.json(); }
  async function refresh(){
    try{ var d=await fetchLocal(); cache=d; render(d); if(popup&&popup.style.display!=="none"){ await fetchHist(); renderPopup(); } return;}catch(e){}
    try{ var d2=await fetchDirect(); cache=d2; render(d2); if(popup&&popup.style.display!=="none")renderPopup();}catch(e2){ var inner=document.getElementById("oq-inline"); if(inner&&!cache) inner.textContent="—"; }
  }
  function ensureTimer(){ if(!timerStarted){ timerStarted=true; refresh(); setInterval(refresh, REFRESH_MS); } }

  function tryInject(){
    if(quotaEl && quotaEl.isConnected) return true;
    var btns=Array.from(document.querySelectorAll("button"));
    var anchorBtn=null;
    for(var i=0;i<btns.length;i++){
      var t=(btns[i].textContent||"").replace(/\s+/g,"");
      if(t.indexOf("添加命令")!==-1 || t.indexOf("AddCommand")!==-1){
        var p=btns[i], inMenu=false;
        for(var d=0;d<5 && p;d++){ if(p.getAttribute && (p.getAttribute("role")==="menuitem"||p.getAttribute("role")==="menu")){ inMenu=true; break; } p=p.parentElement; }
        if(inMenu) continue;
        anchorBtn=btns[i]; break;
      }
    }
    if(anchorBtn && anchorBtn.parentElement){
      quotaEl=makeQuotaEl();
      anchorBtn.parentElement.insertBefore(quotaEl, anchorBtn);
      applyFold();
      ensureTimer(); return true;
    }
    var grp=document.querySelector('[class*="group/cmd"]');
    if(grp && grp.parentElement){
      quotaEl=makeQuotaEl();
      grp.parentElement.insertBefore(quotaEl, grp);
      applyFold();
      ensureTimer(); return true;
    }
    return false;
  }

  function mount(){
    var obs=new MutationObserver(function(){ if(!quotaEl || !quotaEl.isConnected){ if(popup) popup.style.display="none"; tryInject(); } });
    obs.observe(document.documentElement, { childList:true, subtree:true });
    var n=0;
    var fast=setInterval(function(){ if(tryInject() || ++n>40) clearInterval(fast); }, 500);
    tryInject();
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
