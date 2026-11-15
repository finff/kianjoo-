/* Extracted from index.php — keep in sync; no inline styles/scripts (hard rule). */
  (function(){
    var eye=document.getElementById('lg-eye'), pass=document.getElementById('lg-pass');
    eye.addEventListener('click',function(){ var show=pass.type==='password'; pass.type=show?'text':'password';
      eye.classList.toggle('on',show); eye.setAttribute('aria-label',show?'Hide password':'Show password'); eye.title=show?'Hide password':'Show password'; pass.focus(); });
    document.getElementById('lg-form').addEventListener('submit',function(){ var b=document.getElementById('lg-go');
      b.classList.add('busy'); b.querySelector('.lbl').textContent='Signing in…'; });
  })();
