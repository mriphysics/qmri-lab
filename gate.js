(()=>{
  const expected='da08a9a8815bbdb6464c1ccd7b5ed58b01372bb8dc14a2eca64cf8eded71a8d5';
  const storageKey='qmri-lab-access-v1';
  const gate=document.querySelector('#accessGate');
  const form=document.querySelector('#accessForm');
  const input=document.querySelector('#accessPassword');
  const error=document.querySelector('#accessError');

  function remembered(){try{return sessionStorage.getItem(storageKey)===expected}catch{return false}}
  function remember(){try{sessionStorage.setItem(storageKey,expected)}catch{}}
  function appendScript(src,marker,onload){
    const script=document.createElement('script');
    script.src=src;
    script.dataset[marker]='true';
    if(onload)script.addEventListener('load',onload,{once:true});
    document.body.append(script);
  }
  function loadLab(){
    document.body.classList.remove('locked');
    gate.hidden=true;
    if(document.querySelector('script[data-qmri-app]'))return;
    if(window.QMRIChallenge)appendScript('app.js','qmriApp');
    else appendScript('challenge-core.js','qmriCore',()=>appendScript('app.js','qmriApp'));
  }
  async function hash(value){
    const bytes=new TextEncoder().encode(value);
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  }

  if(remembered())loadLab();
  else{
    input.focus();
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      error.textContent='';
      const submit=form.querySelector('button[type="submit"]');
      submit.disabled=true;
      const correct=await hash(input.value)===expected;
      submit.disabled=false;
      if(correct){remember();loadLab()}
      else{error.textContent='That password was not recognised. Check it and try again.';input.select();input.focus()}
    });
  }
})();
