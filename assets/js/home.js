/* Extracted from home.html — keep in sync; no inline styles/scripts (hard rule). */
  (function(){
    document.getElementById('yr').textContent=new Date().getFullYear();
    // Nav turns solid once the page scrolls past the hero top.
    var h=document.getElementById('top');
    var onScroll=function(){ h.classList.toggle('solid', window.scrollY>24); };
    onScroll(); window.addEventListener('scroll', onScroll, {passive:true});
    // Sections fade up as they come into view.
    var els=document.querySelectorAll('.reveal');
    if(!('IntersectionObserver' in window)){ els.forEach(function(e){ e.classList.add('in'); }); return; }
    var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } }); },{rootMargin:'0px 0px -8% 0px', threshold:.08});
    els.forEach(function(e){ io.observe(e); });
  })();
