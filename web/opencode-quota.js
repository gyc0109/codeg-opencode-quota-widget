(function(){
  if(window.__codegQuotaMounted) return; // 防重复注入（多 webview 共用配置 / 重复 userScript）
  window.__codegQuotaMounted=true;
  // 端点解析：http(s) 页面（Linux 服务端 / 浏览器模式）走同源相对路径；
  // 桌面壳（tauri:// 等自定义协议）无法同源取静态文件，统一走本机 sidecar。
  var IS_WEB=/^https?:$/.test((location.protocol||"").toLowerCase());
  var API_ORIGIN=IS_WEB?(location.protocol+"//"+location.hostname+":3081"):"http://127.0.0.1:3081";
  var JSON_URL=IS_WEB?"/opencode-quota.json":API_ORIGIN+"/quota.json";
  var SRC_URL=IS_WEB?"/opencode-quota-sources.json":API_ORIGIN+"/quota-sources.json";
  var HIST_URL=IS_WEB?"/opencode-quota-history.jsonl":API_ORIGIN+"/quota-history.jsonl";
  var API_URL="https://opencode.ai/zen/go/v1/usage", REFRESH_MS=60000;
  var LS_ACCT="opencode-quota-account", LS_MODE="opencode-quota-mode", LS_FOLD="opencode-quota-folded"; // mode: left|used

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
      alert:"额度告急",
      alertPct:function(n,w,p){ return "["+n+"] "+w+" 已用 "+p+"%"; },
      alertBelow:function(n,v){ return "["+n+"] 余额低于 "+v; },
      alertRunOut:function(n,w,c){ return "["+n+"] "+w+" 预计"+c+"耗尽"; },
      perHourSuffix:"/时",
      drainOut:function(c){ return "约"+c+"耗尽"; },
      noRunOut:"暂无耗尽趋势",
      srcStale:"数据暂不可用",
      acctStale:"数据为上次成功抓取",
      statToday:"今日", statHour:"近1小时", stat30d:"近30天", statCache:"缓存读取", statCost:"花费",
      reqUnit:"请求", errUnit:"错误", turnUnit:"轮", monthWord:"本月",
      limitDaily:"日限额", limitMonthly:"月限额",
      perModel:"按模型", perAgent:"按 agent",
      errRate:function(p){ return "近1小时错误率 "+p+"%"; },
      alertHealth:function(n,e){ return "["+n+"] 上游异常："+e; },
      h24:"24小时用量",
      hMax:function(p){ return "最高 "+p+"%"; },
      hPeak:function(v){ return "峰值 "+v; }
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
      alert:"Quota alert",
      alertPct:function(n,w,p){ return "["+n+"] "+w+" used "+p+"%"; },
      alertBelow:function(n,v){ return "["+n+"] balance below "+v; },
      alertRunOut:function(n,w,c){ return "["+n+"] "+w+" runs out "+c.replace(" left",""); },
      perHourSuffix:"/h",
      drainOut:function(c){ return "runs out ~"+c.replace(" left",""); },
      noRunOut:"no run-out trend",
      srcStale:"data unavailable",
      acctStale:"showing last successful fetch",
      statToday:"Today", statHour:"Last hour", stat30d:"Last 30d", statCache:"Cache read", statCost:"Cost",
      reqUnit:"req", errUnit:"err", turnUnit:"turns", monthWord:"month",
      limitDaily:"Daily limit", limitMonthly:"Monthly limit",
      perModel:"By model", perAgent:"By agent",
      errRate:function(p){ return p+"% errors in the last hour"; },
      alertHealth:function(n,e){ return "["+n+"] upstream issue: "+e; },
      h24:"24h usage",
      hMax:function(p){ return "peak "+p+"%"; },
      hPeak:function(v){ return "peak "+v; }
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

  var quotaEl=null, popup=null, cache=null, histCache=null, srcCache=null, timerStarted=false;
  var LS_PROVIDER="opencode-quota-provider";
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

  // ---- provider / 窗口模型（新格式 windows 优先，旧格式 usage 兜底） ----
  function providerOf(a){ return (a&&a.provider)||"opencode-go"; }
  function providerList(data){
    var out=[], seen={}, list=(data&&data.accounts)||[];
    for(var i=0;i<list.length;i++){ var p=providerOf(list[i]); if(!seen[p]){ seen[p]=1; out.push(p); } }
    return out;
  }
  function accountsOf(data, provider){
    return ((data&&data.accounts)||[]).filter(function(a){ return providerOf(a)===provider; });
  }
  var PROVIDER_NAMES={ "opencode-go":"OpenCode Go", "deepseek":"DeepSeek", "openrouter":"OpenRouter" };
  function providerName(p){ return PROVIDER_NAMES[p]||p; }
  var KNOWN_PROVIDERS=["opencode-go","deepseek","openrouter"];  // 与 _codeg_quota_providers.ADAPTERS 对应
  var STALE_MIN=6;  // 数据年龄超此分钟数视为过期（余额类 provider 本身 300s 一抓）
  var ALERT_PREFIX="oq-alerted-";
  var LEGACY_SPECS=[
    {id:"rolling",label:{zh:"5小时",en:"5-hour"},primary:true,alert:{pct:[80]}},
    {id:"weekly",label:{zh:"每周",en:"Weekly"},alert:{pct:[90]}},
    {id:"monthly",label:{zh:"每月",en:"Monthly"},alert:{pct:[95]}}
  ];
  function windowsOf(acct){
    if(!acct) return [];
    if(acct.windows&&acct.windows.length) return acct.windows;
    if(acct.usage){
      var out=[];
      for(var i=0;i<LEGACY_SPECS.length;i++){
        var s=LEGACY_SPECS[i], d=acct.usage[s.id];
        if(!d) continue;
        out.push({id:s.id,label:s.label,primary:s.primary,kind:"percent",direction:"used",
                  percent:d.percent,resetsAt:d.resetsAt,alert:s.alert});
      }
      return out;
    }
    return [];
  }
  function L(label){
    if(label==null) return "";
    if(typeof label==="string") return label;
    return label[lang()]||label.en||label.zh||"";
  }
  function hasData(a){ return !!(a&&((a.windows&&a.windows.length)||a.usage)); }
  function fmtMoney(v,unit){
    if(v==null) return "—";
    var sym=unit==="CNY"?"¥":(unit==="USD"?"$":"");
    var n=Math.abs(v)>=1000?String(Math.round(v)):(Math.abs(v)>=100?Number(v).toFixed(1):Number(v).toFixed(2));
    return sym?sym+n:(n+" "+(unit||""));
  }
  function shortLabel(w){
    var t=S(), m={rolling:"pill5h",weekly:"pillWeek",monthly:"pillMonth"};
    if(m[w.id]&&t[m[w.id]]) return t[m[w.id]];
    return L(w.label);
  }
  function colorFor(p){ return p>=90?"#ef4444":p>=70?"#eab308":"#22c55e"; }
  function dot(p){ return '<span style="display:inline-block;width:6px;height:6px;border-radius:99px;background:'+colorFor(p)+';margin-right:2px;vertical-align:1px"></span>'; }
  function getAcctSel(){
    var v=localStorage.getItem(LS_ACCT)||"", i=v.indexOf("/");
    return i>0?{provider:v.slice(0,i),name:v.slice(i+1)}:{provider:"opencode-go",name:v};
  }
  function setAcctSel(p,n){ try{ localStorage.setItem(LS_ACCT, p+"/"+n); }catch(e){} }
  function activeProvider(data){
    var saved=localStorage.getItem(LS_PROVIDER);
    var list=providerList(data);
    if(saved&&list.indexOf(saved)>=0) return saved;
    var sel=getAcctSel();
    if(list.indexOf(sel.provider)>=0) return sel.provider;
    return list[0]||"opencode-go";
  }
  function pickAccount(data, provider){
    if(!data) return null;
    var list=data.accounts||[];
    if(!list.length){
      // 兼容老格式 {usage:{...}}
      if(data.usage) return { provider:"opencode-go", name:"", usage:data.usage };
      return null;
    }
    var sel=getAcctSel();
    var pool=provider?accountsOf(data,provider):list;
    for(var i=0;i<pool.length;i++){
      if(pool[i].name===sel.name && providerOf(pool[i])===sel.provider && hasData(pool[i])) return pool[i];
    }
    for(var j=0;j<pool.length;j++) if(hasData(pool[j])) return pool[j];
    return pool[0]||list[0];
  }

  // 告警收集：窗口百分比阈值 / 余额低于阈值 / 预计耗尽；key 带 provider 防止跨源撞名
  function collectAlerts(data){
    var out=[], list=(data&&data.accounts)||[];
    for(var i=0;i<list.length;i++){
      var a=list[i], p=providerOf(a), ws=windowsOf(a);
      for(var j=0;j<ws.length;j++){
        var w=ws[j], al=w.alert||{};
        if(w.kind==="percent" && w.percent!=null && al.pct && al.pct.length){
          for(var k=0;k<al.pct.length;k++){
            var th=al.pct[k];
            if(w.percent>=th) out.push({key:"p:"+p+":"+a.name+":"+w.id+":"+th, kind:"pct",
              name:a.name, provider:p, win:L(w.label), pct:w.percent});
          }
        }
        if((w.kind==="money"||w.kind==="budget") && w.value!=null && al.below!=null && w.value<al.below){
          out.push({key:"p:"+p+":"+a.name+":"+w.id+":below", kind:"below",
            name:a.name, provider:p, win:L(w.label), value:w.value, unit:w.unit});
        }
        if(w.burn && w.burn.runOutAt && al.runOutHours){
          var hrs=(Date.parse(w.burn.runOutAt)-Date.now())/3600000;
          if(hrs>0 && hrs<al.runOutHours){
            out.push({key:"p:"+p+":"+a.name+":"+w.id+":runout", kind:"runout",
              name:a.name, provider:p, win:L(w.label), runOutAt:w.burn.runOutAt});
          }
        }
      }
    }
    return out;
  }
  // 每个 key 通知一次；恢复后清除；老版本按账号名的 key 做迁移避免重复通知
  function applyAlerts(data){
    if(!quotaEl) return;
    var alerts=collectAlerts(data).concat(collectSourceAlerts()), seen={}, t=S();
    for(var i=0;i<alerts.length;i++){
      var al=alerts[i];
      seen[al.key]=1;
      if(localStorage.getItem(ALERT_PREFIX+al.key)) continue;
      var legacyKey="opencode-quota-alerted-"+al.name;
      if(al.name&&localStorage.getItem(legacyKey)){
        // 老版本 key 迁移：种下新 key 后立即删除老 key（否则该账号通知被永久压制）
        localStorage.setItem(ALERT_PREFIX+al.key,"1");
        try{ localStorage.removeItem(legacyKey); }catch(e){}
        continue;
      }
      localStorage.setItem(ALERT_PREFIX+al.key,"1");
      var body="";
      if(al.kind==="pct") body=t.alertPct(al.name||providerName(al.provider), al.win, al.pct);
      else if(al.kind==="below") body=t.alertBelow(al.name||providerName(al.provider), fmtMoney(al.value,al.unit));
      else if(al.kind==="runout") body=t.alertRunOut(al.name||providerName(al.provider), al.win, countdown(al.runOutAt));
      else if(al.kind==="health") body=t.alertHealth(al.name||"", al.lastError||"");
      else if(al.kind==="limit") body=t.alertPct(al.name||"", al.win||"", al.pct);
      try{
        if("Notification" in window && Notification.permission==="granted"){ new Notification(t.alert,{body:body}); }
      }catch(e){}
    }
    // 只在数据权威（含账号清单）时清理已恢复的 key——
    // fetchDirect 降级数据没有 accounts，横扫会误删全部 key 造成重复通知
    try{
      var authoritative=!!((data&&data.accounts&&data.accounts.length));
      if(authoritative){
        var rm=[];
        for(var n=0;n<localStorage.length;n++){
          var lk=localStorage.key(n);
          if(lk && lk.indexOf(ALERT_PREFIX)===0 && !seen[lk.slice(ALERT_PREFIX.length)]) rm.push(lk);
        }
        rm.forEach(function(x){ localStorage.removeItem(x); });
      }
    }catch(e2){}
    if(alerts.length) quotaEl.classList.add("oq-alert");
    else quotaEl.classList.remove("oq-alert");
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
      // 用户手势里顺便申请通知权限（仅当有告警——含数据源告警，避免打扰）
      try{
        if(collectAlerts(cache).concat(collectSourceAlerts()).length
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
    p=Number(p)||0;
    if(mode==="used") return "<b>"+p+"%</b> "+t.used;
    return "<b>"+(100-p)+"%</b> "+t.left;
  }

  function render(data){
    if(!quotaEl) return;
    var t=S();
    var inner=document.getElementById("oq-inline");
    if(!inner) return;
    var providers=providerList(data);
    if(!providers.length){
      var a0=pickAccount(data);
      if(!a0||!hasData(a0)){ inner.textContent="—"; applyAlerts(data); return; }
      providers=["opencode-go"];
    }
    var mode=getMode(), parts=[], titleLines=[];
    for(var i=0;i<providers.length;i++){
      var p=providers[i], a=pickAccount(data,p), ws=windowsOf(a);
      if(!ws.length){ parts.push('<span style="opacity:.5">'+esc(providerName(p))+' —</span>'); continue; }
      var segs=[], shown=0;
      for(var j=0;j<ws.length&&shown<3;j++){
        var w=ws[j];
        if(w.pill===false) continue;
        if(w.kind==="percent"&&w.percent!=null){
          var wp=Number(w.percent)||0;
          segs.push(dot(wp)+'<span style="opacity:.6">'+esc(shortLabel(w))+'</span> <b>'+(mode==="used"?wp:(100-wp))+'%</b>');
          shown++;
        } else if((w.kind==="money"||w.kind==="budget")&&w.value!=null){
          segs.push('<span style="opacity:.6">'+esc(shortLabel(w))+'</span> <b>'+esc(fmtMoney(w.value,w.unit))+'</b>');
          shown++;
        }
      }
      var multiAcct=accountsOf(data,p).length>1;
      var head=(providers.length>1||multiAcct)?
        '<span style="opacity:.55;max-width:70px;overflow:hidden;text-overflow:ellipsis">'+
        esc(providers.length>1?providerName(p):((a&&a.name)||""))+'</span><span style="opacity:.25">·</span>':"";
      parts.push(head+segs.join('<span style="opacity:.25;margin:0 5px">·</span>')+((a&&a.stale)?'<span style="color:#eab308;margin-left:4px">⚠</span>':""));
      var pline=providerName(p)+" "+ws.filter(function(x){ return x.kind==="percent"&&x.percent!=null; })
        .map(function(x){ return shortLabel(x)+" "+x.percent+"%"; }).join(" | ");
      titleLines.push((a&&a.name?("["+a.name+"] "):"")+pline);
    }
    var hbad=healthSummary();
    if(hbad) parts.push('<span style="color:#ef4444">● '+hbad+'</span>');
    inner.innerHTML=parts.join('<span style="opacity:.25;margin:0 6px">|</span>');
    Array.from(inner.querySelectorAll("b")).forEach(function(b){ b.style.fontWeight="600"; b.style.color="var(--foreground,#111)"; });
    var age=dataAgeMin();
    // 数据过期药丸变淡，悬停说明（阈值见 STALE_MIN）
    quotaEl.style.opacity=(age!=null&&age>STALE_MIN)?".45":"";
    quotaEl.title=titleLines.join("  ·  ")+" — "+t.openDetail+"，"+t.foldHint+(age!=null&&age>STALE_MIN?(" · "+t.stale(age)):"");
    applyAlerts(data);
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
  function burnHtml(w){
    if(!w.burn||w.burn.perHour==null) return "";
    var t=S(), rate=w.burn.perHour, txt;
    if(w.kind==="percent") txt=(rate>0?"↑":"↓")+Math.abs(rate)+"%"+t.perHourSuffix;
    else txt=(rate>0?"↑":"↓")+fmtMoney(Math.abs(rate),w.unit)+t.perHourSuffix;
    var out='<span style="opacity:.65">'+esc(txt)+'</span>';
    if(w.burn.runOutAt) out+='<span style="opacity:.6;margin-left:10px">'+esc(t.drainOut(countdown(w.burn.runOutAt)))+'</span>';
    else out+='<span style="opacity:.45;margin-left:10px">'+esc(t.noRunOut)+'</span>';
    return '<div style="padding:0 0 4px 60px;font-size:11px">'+out+'</div>';
  }
  function rowHtml(label, w){
    var mode=getMode();
    if(w.kind==="percent"&&w.percent==null) return "";
    if(w.kind==="percent") w={ id:w.id,kind:w.kind,direction:w.direction,percent:Number(w.percent)||0,
                               resetsAt:w.resetsAt,unit:w.unit,burn:w.burn,alert:w.alert,label:w.label };
    var pct=(w.kind==="percent")?w.percent:((w.kind==="budget"&&w.limit)?Math.round(w.value/w.limit*100):null);
    var bar=pct!=null?
      '<span style="display:inline-block;width:64px;height:5px;background:rgba(127,127,127,0.2);border-radius:99px;vertical-align:middle;overflow:hidden"><span style="display:block;width:'+Math.min(100,Math.max(0,pct))+'%;height:100%;background:'+colorFor(pct)+'"></span></span>'
      :'<span style="display:inline-block;width:64px"></span>';
    var val;
    if(w.kind==="percent") val=numLine(w.percent, mode);
    else if(w.kind==="budget") val='<b>'+esc(fmtMoney(w.value,w.unit))+'</b>'+(w.limit!=null?(' <span style="opacity:.55">/ '+esc(fmtMoney(w.limit,w.unit))+'</span>'):'');
    else if(w.kind==="money") val='<b>'+esc(fmtMoney(w.value,w.unit))+'</b>';
    else val='<b>'+esc(String(w.value==null?"—":w.value))+'</b>';
    var reset=w.resetsAt?(fmtDate(w.resetsAt)+'<br>'+countdown(w.resetsAt)):'';
    return '<div style="border-top:1px solid var(--border,rgba(0,0,0,0.06))">'
      +'<div style="display:flex;align-items:center;gap:8px;padding:5px 0">'
      +'<span style="width:52px;color:var(--muted-foreground,#71717a)">'+esc(label)+'</span>'
      +bar
      +'<span style="min-width:76px;text-align:right">'+val+'</span>'
      +'<span style="flex:1"></span>'
      +'<span style="text-align:right;color:var(--muted-foreground,#71717a);font-size:11px">'+reset+'</span>'
      +'</div>'+burnHtml(w)+'</div>';
  }
  // 24h 曲线：当前账号主窗口迷你 SVG（provider 感知，金额窗口显示单位）
  function sparkHtml(acct){
    var t=S();
    if(!histCache||!histCache.length) return '<div style="opacity:.5;font-size:11px;padding:4px 0">'+t.collecting+'</div>';
    var name=(acct&&acct.name)||"", prov=acct?providerOf(acct):"opencode-go";
    var ws=windowsOf(acct);
    var prim=null;
    for(var x=0;x<ws.length;x++){ if(ws[x].primary){ prim=ws[x]; break; } }
    if(!prim&&ws.length) prim=ws[0];
    var unit=prim?prim.unit:null, isPct=!prim||prim.kind==="percent";
    var vals=[];
    for(var i=0;i<histCache.length;i++){
      var pts=histCache[i].a||[];
      for(var j=0;j<pts.length;j++){
        var pt=pts[j];
        if(pt.n!==name) continue;
        var pp=pt.p;
        if(pp==null? prov!=="opencode-go" : pp!==prov) continue;
        if(pt.r!=null) vals.push(pt.r);
        break;
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
    var peak=isPct?t.hMax(max):t.hPeak(fmtMoney(max,unit));
    return '<div style="padding:6px 0 2px;border-top:1px solid var(--border,rgba(0,0,0,0.06))">'
      +'<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted-foreground,#71717a);margin-bottom:2px"><span>'+t.h24+'</span><span>'+esc(peak)+'</span></div>'
      +'<svg viewBox="0 0 '+W+' '+H+'" style="display:block;width:100%;height:40px"><polyline points="'+d+'" fill="none" stroke="var(--primary,#71717a)" stroke-width="1.5"/></svg></div>';
  }
  // ---- 本地数据源（cc-switch / codeg 用量）面板 ----
  var SOURCE_NAMES={ "cc-switch":{zh:"CC Switch",en:"CC Switch"}, "codeg-usage":{zh:"codeg 用量",en:"codeg usage"} };
  function sourceName(sid){ var n=SOURCE_NAMES[sid]; return n?L(n):sid; }
  function sourceTabs(){ try{ return srcCache&&srcCache.sources?Object.keys(srcCache.sources):[]; }catch(e){ return []; } }
  function healthSummary(){
    try{
      var b=srcCache&&srcCache.sources&&srcCache.sources["cc-switch"];
      if(!b||b.stale) return 0;
      var bad=0;
      (b.health||[]).forEach(function(x){ if(x.healthy===false) bad++; });
      var hr=b.totals&&b.totals.hour;
      if(hr&&hr.requests>=10&&hr.errorRate>0.2) bad=Math.max(bad,1);
      return bad;
    }catch(e){ return 0; }
  }
  function fmtTokens(n){
    n=Number(n)||0;
    if(n>=1e9) return (n/1e9).toFixed(2)+"B";
    if(n>=1e6) return (n/1e6).toFixed(1)+"M";
    if(n>=1e3) return (n/1e3).toFixed(1)+"K";
    return String(n);
  }
  function statRowHtml(rows){
    var h='<div style="font-size:11px;padding:2px 0 6px">';
    rows.forEach(function(r){
      h+='<div style="display:flex;gap:8px;padding:1px 0"><span style="opacity:.55;min-width:64px">'+esc(r[0])+'</span><span>'+esc(r[1])+'</span></div>';
    });
    return h+'</div>';
  }
  function tabBarHtml(providers, srcIds, activeP, activeSrc){
    var h='<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">';
    providers.forEach(function(p){
      var act=p===activeP, bad=!(cache&&accountsOf(cache,p).some(hasData));
      h+='<span data-prov="'+esc(p)+'" style="cursor:pointer;font-size:11px;border-radius:99px;border:1px solid var(--border,rgba(0,0,0,0.1));padding:3px 10px;'
        +(act?'background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent;font-weight:600;':'opacity:'+(bad?'0.4':'0.75'))+'">'+esc(providerName(p))+'</span>';
    });
    srcIds.forEach(function(sid){
      var b=(srcCache&&srcCache.sources&&srcCache.sources[sid])||{};
      var bad=b.stale||b.ok===false, act=sid===activeSrc;
      h+='<span data-src="'+esc(sid)+'" style="cursor:pointer;font-size:11px;border-radius:99px;border:1px solid var(--border,rgba(0,0,0,0.1));padding:3px 10px;'
        +(act?'background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent;font-weight:600;':'opacity:'+(bad?'0.45':'0.75'))
        +'">'+esc(sourceName(sid))+(bad?' ⚠':'')+'</span>';
    });
    return h+'</div>';
  }
  function bindTabs(){
    if(!popup) return;
    Array.from(popup.querySelectorAll("[data-prov]")).forEach(function(s){
      s.addEventListener("click", function(e){ e.stopPropagation(); try{ localStorage.setItem(LS_PROVIDER, s.getAttribute("data-prov")); }catch(e2){} renderPopup(); });
    });
    Array.from(popup.querySelectorAll("[data-src]")).forEach(function(s){
      s.addEventListener("click", function(e){ e.stopPropagation(); try{ localStorage.setItem(LS_PROVIDER, "src:"+s.getAttribute("data-src")); }catch(e2){} renderPopup(); });
    });
  }
  function srcFooterHtml(sid){
    var t=S(), ageTxt="", age=null;
    var b=(srcCache&&srcCache.sources&&srcCache.sources[sid])||{};
    var ts=b.fetchedAt||(srcCache&&srcCache._fetchedAt);
    try{
      if(ts){ var d=new Date(Date.parse(ts)); ageTxt=pad(d.getHours())+":"+pad(d.getMinutes());
              age=Math.max(0,Math.round((Date.now()-Date.parse(ts))/60000)); }
    }catch(e){}
    if(age!=null&&age>STALE_MIN) ageTxt+=(ageTxt?" · ":"")+t.stale(age);
    return '<div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:11px;color:var(--muted-foreground,#71717a)">'
      +'<span style="flex:1"></span>'
      +'<span data-act="refresh" title="'+t.refresh+'" style="cursor:pointer;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;line-height:1">↻</span>'
      +'<span>'+ageTxt+'</span></div>';
  }
  function sourcePanelHtml(sid){
    var t=S();
    var b=(srcCache&&srcCache.sources&&srcCache.sources[sid])||null;
    if(!b) return '<div style="opacity:.6">'+t.noData+'</div>';
    var h='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-weight:650">'+esc(sourceName(sid))+'</span>'
      +(b.stale?('<span style="color:#eab308;font-size:11px">'+esc(t.srcStale)+'</span>'):'')+'</div>';
    if(b.error) h+='<div style="color:#f87171;font-size:11px;margin-bottom:6px">'+esc(String(b.error))+'</div>';
    var sect='border-top:1px solid var(--border,rgba(0,0,0,0.06));margin-top:6px;padding-top:6px;font-size:11px';
    if(sid==="cc-switch"){
      var tt=b.totals||{}, td=tt.today||{}, hr=tt.hour||{}, mo=tt.month||{};
      if(tt.today){
        h+=statRowHtml([
          [t.statToday, td.requests+" "+t.reqUnit+" · "+td.errors+" "+t.errUnit+" ("+Math.round((td.errorRate||0)*100)+"%)"],
          [t.statCost, fmtMoney(td.cost,"USD")+" · "+t.monthWord+" "+fmtMoney(mo.cost,"USD")],
          [t.statHour, hr.requests+" "+t.reqUnit+" · "+hr.errors+" "+t.errUnit]
        ]);
      }
      (b.limits||[]).forEach(function(l){
        h+=rowHtml(l.window==="daily"?t.limitDaily:t.limitMonthly,
          {kind:"budget", value:l.value, limit:l.limit, unit:l.unit});
      });
      if((b.health||[]).length){
        h+='<div style="'+sect+'">';
        b.health.forEach(function(x){
          var c=x.healthy===false?"#ef4444":((x.consecutiveFailures||0)>0?"#eab308":"#22c55e");
          h+='<div style="display:flex;gap:8px;align-items:baseline;padding:2px 0">'
            +'<span style="display:inline-block;width:6px;height:6px;border-radius:99px;background:'+c+';flex-shrink:0"></span>'
            +'<span>'+esc(x.name)+' <span style="opacity:.5">'+esc(x.app)+'</span></span>'
            +'<span style="flex:1"></span>'
            +'<span style="opacity:.6;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(x.lastError||"")+'">'+esc((x.lastError||"").slice(0,60))+'</span></div>';
        });
        h+='</div>';
      }
      if((b.models||[]).length){
        h+='<div style="'+sect+'"><div style="opacity:.55;margin-bottom:2px">'+t.perModel+'</div>';
        b.models.slice(0,5).forEach(function(m){
          h+='<div style="display:flex;gap:8px;padding:1px 0"><span style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(m.model)+'</span>'
            +'<span style="flex:1"></span><span style="opacity:.8">'+esc(fmtMoney(m.cost,"USD"))+'</span>'
            +'<span style="opacity:.5;min-width:56px;text-align:right">'+m.requests+' '+esc(t.reqUnit)+'</span>'
            +(m.errors?('<span style="color:#f87171;min-width:46px;text-align:right">'+m.errors+' '+esc(t.errUnit)+'</span>'):'')+'</div>';
        });
        h+='</div>';
      }
    } else if(sid==="codeg-usage"){
      var ty=(b.totals||{}).today||{}, d30=(b.totals||{}).d30||{};
      if((b.totals||{}).today){
        h+=statRowHtml([
          [t.statToday, fmtTokens(ty.totalTokens)+" · "+ty.turns+" "+t.turnUnit],
          [t.stat30d, fmtTokens(d30.totalTokens)+" · "+d30.turns+" "+t.turnUnit],
          [t.statCache, fmtTokens(ty.cacheReadTokens)]
        ]);
      }
      if((b.byModel||[]).length){
        h+='<div style="'+sect+'"><div style="opacity:.55;margin-bottom:2px">'+t.perModel+'</div>';
        b.byModel.slice(0,6).forEach(function(m){
          h+='<div style="display:flex;gap:8px;padding:1px 0"><span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(m.key)+'</span>'
            +'<span style="flex:1"></span><span style="opacity:.75">'+fmtTokens(m.tokens)+'</span>'
            +'<span style="opacity:.5;min-width:44px;text-align:right">'+m.turns+' '+esc(t.turnUnit)+'</span></div>';
        });
        h+='</div>';
      }
      if((b.byAgent||[]).length){
        h+='<div style="'+sect+'"><div style="opacity:.55;margin-bottom:2px">'+t.perAgent+'</div>';
        b.byAgent.slice(0,5).forEach(function(a){
          h+='<div style="display:flex;gap:8px;padding:1px 0"><span style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.key)+'</span>'
            +'<span style="flex:1"></span><span style="opacity:.75">'+fmtTokens(a.tokens)+'</span>'
            +'<span style="opacity:.5;min-width:44px;text-align:right">'+a.turns+' '+esc(t.turnUnit)+'</span></div>';
        });
        h+='</div>';
      }
    }
    return h;
  }
  function collectSourceAlerts(){
    var out=[];
    try{
      var t=S();
      var b=srcCache&&srcCache.sources&&srcCache.sources["cc-switch"];
      if(b&&!b.stale){
        var hourKey=Math.floor(Date.now()/3600000);
        (b.health||[]).forEach(function(x){
          if(x.healthy===false){
            out.push({key:"h:cc-switch:"+x.providerId+":"+x.app+":"+hourKey, kind:"health",
                      name:x.name||"", provider:x.app, lastError:(x.lastError||"").slice(0,80)});
          }
        });
        var hr=b.totals&&b.totals.hour;
        if(hr&&hr.requests>=10&&hr.errorRate>0.2){
          out.push({key:"h:cc-switch:rate:"+hourKey, kind:"health", name:"cc-switch",
                    provider:"", lastError:t.errRate(Math.round(hr.errorRate*100))});
        }
        (b.limits||[]).forEach(function(l){
          if(l.limit>0){
            var pct=l.value/l.limit*100;
            [80,100].forEach(function(th){
              if(pct>=th) out.push({key:"s:cc-switch:"+l.providerId+":"+l.app+":"+l.window+":"+th,
                kind:"limit", name:l.name||"", provider:l.app,
                win:(l.window==="daily"?t.limitDaily:t.limitMonthly), pct:Math.round(pct)});
            });
          }
        });
      }
    }catch(e){}
    return out;
  }

  function renderPopup(){
    if(!popup || !cache) return;
    var t=S();
    // 本地数据源视图（tab 前缀 src:）
    var srcIds=sourceTabs();
    var tabNow="";
    try{ tabNow=localStorage.getItem(LS_PROVIDER)||""; }catch(e0){}
    var activeSrc=(tabNow.indexOf("src:")===0&&srcIds.indexOf(tabNow.slice(4))>=0)?tabNow.slice(4):null;
    // 没有任何账号数据时，若有本地数据源则直接展示数据源（否则面板永远进不去）
    if(!activeSrc && srcIds.length && !providerList(cache).length){ activeSrc=srcIds[0]; }
    if(activeSrc){
      popup.innerHTML=tabBarHtml(providerList(cache), srcIds, null, activeSrc)
        +sourcePanelHtml(activeSrc)+srcFooterHtml(activeSrc);
      bindTabs();
      var rf0=popup.querySelector('[data-act="refresh"]');
      if(rf0) rf0.addEventListener("click", function(e){ e.stopPropagation(); refresh(); });
      return;
    }
    // 先保住表单状态：自动刷新重建 DOM 时不吃掉正在输入的字
    var keepForm=null;
    try{
      var _f=popup.querySelector('[data-form="add"]');
      if(_f&&_f.style.display!=="none"){
        keepForm={ open:true,
          name:(_f.querySelector('[data-in="name"]')||{}).value||"",
          key:(_f.querySelector('[data-in="key"]')||{}).value||"",
          prov:(_f.querySelector('[data-in="provider"]')||{}).value||"",
          err:((_f.querySelector('[data-form-err]')||{}).textContent||"") };
      }
    }catch(e){}
    var providers=providerList(cache);
    if(!providers.length){ popup.innerHTML='<div style="opacity:.6">'+t.noData+'</div>'; return; }
    var activeP=activeProvider(cache);
    var acct=pickAccount(cache, activeP);
    var list=accountsOf(cache, activeP);
    var mode=getMode();
    var html="";
    var addBtnHtml='<span data-act="add-form" title="'+t.addKey+'" style="cursor:pointer;font-size:14px;line-height:1;opacity:.6;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center">＋</span>';
    // provider Tab + 本地数据源 Tab
    if(providers.length+sourceTabs().length>1){
      html+=tabBarHtml(providers, sourceTabs(), activeP, null);
    }
    // 账号 Tab（当前 provider 下 >1 个时）
    if(list.length>1){
      html+='<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">';
      list.forEach(function(a){
        var active=acct&&a.name===acct.name;
        var bad=!hasData(a);
        html+='<span style="display:inline-flex;align-items:center;font-size:11px;border-radius:99px;border:1px solid var(--border,rgba(0,0,0,0.1));'
          +(active?'background:var(--primary,#111);color:var(--primary-foreground,#fff);border-color:transparent;font-weight:600;':'opacity:'+(bad?'0.4':'0.75'))
          +'">'
          +'<span data-acct="'+esc(a.name)+'" style="cursor:pointer;padding:3px 4px 3px 10px">'+esc(a.name)+(bad?' ✕':'')+'</span>'
          +'<span data-del="'+esc(a.name)+'" data-del-prov="'+esc(activeP)+'" title="'+t.delAcct+'" style="cursor:pointer;padding:3px 8px 3px 2px;opacity:.6">×</span>'
          +'</span>';
      });
      html+='</div>';
    } else {
      html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span style="font-weight:650">⚡ '+esc(acct&&acct.name?acct.name+" ":"")+'<span style="opacity:.45;font-weight:400">'+esc(providerName(activeP))+'</span></span><span style="flex:1"></span>'+addBtnHtml+'</div>';
    }
    var provSelect=(function(){
      var names=KNOWN_PROVIDERS.slice();
      providers.forEach(function(p){ if(names.indexOf(p)<0) names.push(p); });
      if(!names.length) return "";
      return '<select data-in="provider" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;padding:4px 8px;border:1px solid var(--border,rgba(0,0,0,0.15));border-radius:6px;background:transparent;color:inherit;outline:none">'
        +names.map(function(p){ return '<option value="'+esc(p)+'"'+(p===activeP?' selected':'')+'>'+esc(providerName(p))+'</option>'; }).join("")
        +'</select>';
    })();
    html+='<div data-form="add" style="display:none;margin-bottom:8px;padding:8px;border:1px dashed var(--border,rgba(0,0,0,0.15));border-radius:8px">'
      +provSelect
      +'<input data-in="name" placeholder="'+esc(t.aliasPh)+'" maxlength="32" style="width:100%;box-sizing:border-box;margin-bottom:6px;font-size:12px;padding:4px 8px;border:1px solid var(--border,rgba(0,0,0,0.15));border-radius:6px;background:transparent;color:inherit;outline:none">'
      +'<input data-in="key" placeholder="sk-..." autocomplete="off" spellcheck="false" style="width:100%;box-sizing:border-box;margin-bottom:6px;font:11px ui-monospace,monospace;padding:4px 8px;border:1px solid var(--border,rgba(0,0,0,0.15));border-radius:6px;background:transparent;color:inherit;outline:none">'
      +'<div data-form-err style="display:none;color:#f87171;font-size:11px;margin-bottom:6px"></div>'
      +'<div style="display:flex;gap:6px;justify-content:flex-end">'
      +'<span data-act="add-cancel" style="cursor:pointer;font-size:11px;padding:2px 10px;border:1px solid var(--border,rgba(0,0,0,0.1));border-radius:99px;opacity:.7">'+t.cancel+'</span>'
      +'<span data-act="add-save" style="cursor:pointer;font-size:11px;padding:2px 10px;border-radius:99px;background:var(--primary,#111);color:var(--primary-foreground,#fff)">'+t.save+'</span>'
      +'</div></div>';
    var ws=windowsOf(acct);
    if(!ws.length){ html+='<div style="color:#f87171">'+esc(noDataAcct(acct.error||"unknown"))+'</div>'; }
    else{
      ws.forEach(function(w){ html+=rowHtml(L(w.label), w); });
      html+=sparkHtml(acct);
      if(acct.error||acct.stale) html+='<div style="color:#eab308;font-size:11px;margin-top:4px">'+esc(t.acctStale+(acct.error?("："+acct.error):""))+'</div>';
    }
    // 右下角平时只显示抓取时刻 HH:MM；数据过期（>3 分钟）才标 stale
    var age=dataAgeMin();
    var ageTxt="";
    try{
      if(cache&&cache._fetchedAt){ var _fd=new Date(Date.parse(cache._fetchedAt)); ageTxt=pad(_fd.getHours())+":"+pad(_fd.getMinutes()); }
    }catch(e3){}
    if(age!=null&&age>STALE_MIN) ageTxt+=(ageTxt?" · ":"")+t.stale(age);
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
          var _n=_f2.querySelector('[data-in="name"]'), _k=_f2.querySelector('[data-in="key"]'),
              _e=_f2.querySelector('[data-form-err]'), _p=_f2.querySelector('[data-in="provider"]');
          if(_n) _n.value=keepForm.name;
          if(_k) _k.value=keepForm.key;
          if(_p&&keepForm.prov) _p.value=keepForm.prov;
          if(_e&&keepForm.err){ _e.textContent=keepForm.err; _e.style.display=""; }
        }
      }
    }catch(e2){}
    // 绑定
    Array.from(popup.querySelectorAll("[data-acct]")).forEach(function(s){
      s.addEventListener("click", function(e){ e.stopPropagation(); setAcctSel(activeP, s.getAttribute("data-acct")); render(cache); });
    });
    bindTabs();
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
      var provEl=form.querySelector('[data-in="provider"]');
      var provider=provEl&&provEl.value?provEl.value:activeP;
      saveBtn.textContent=t.checking;
      apiCall("POST", "/api/accounts", { name:name, apiKey:key, provider:provider }).then(function(){
        setAcctSel(provider, name);
        try{ localStorage.setItem(LS_PROVIDER, provider); }catch(e0){}
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
        var dprov=x.getAttribute("data-del-prov")||activeP;
        if(!confirm(delConfirm(nm))) return;
        apiCall("DELETE", "/api/accounts?name="+encodeURIComponent(nm)+"&provider="+encodeURIComponent(dprov)).then(function(){
          var sel=getAcctSel();
          if(sel.name===nm&&sel.provider===dprov) localStorage.removeItem(LS_ACCT);
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
  async function fetchSources(){
    try{
      var r=await fetch(SRC_URL+"?t="+Date.now(),{cache:"no-store"});
      if(!r.ok) return;
      srcCache=await r.json();
    }catch(e){}
  }
  async function fetchDirect(){ var k=localStorage.getItem("opencode-go-api-key"); if(!k) throw new Error("no key"); var r=await fetch(API_URL,{headers:{Authorization:"Bearer "+k}}); if(!r.ok) throw new Error("api"); return await r.json(); }
  async function refresh(){
    try{ var d=await fetchLocal(); cache=d; await fetchSources(); render(d); if(popup&&popup.style.display!=="none"){ await fetchHist(); renderPopup(); } return;}catch(e){}
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
