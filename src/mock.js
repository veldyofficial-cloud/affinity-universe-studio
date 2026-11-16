// Local adapter for GitHub Pages: keeps the original Studio UI usable without its server API.
(function(){
  const KEY='affinity-studio-v1';
  const seed={page:{title:'상상에서 시작해,\n나만의 작품으로.',description:'어피니티 유니버스에서 나에게 맞는 창작 과정을 만나보세요.',courses:[{id:'c1',name:'아트북',description:'상상을 그림과 이야기로 표현하는 창작 과정',media:[]},{id:'c2',name:'픽처북',description:'나의 이야기를 한 권의 그림책으로 완성하는 과정',media:[]},{id:'c3',name:'드로잉북',description:'나만의 시선과 표현을 발견하는 드로잉 과정',media:[]} ]},published:null,rules:[{id:'r1',keyword:'클래스,그림책,수강료',reply:'안녕하세요! 어피니티 유니버스입니다. 관심 있는 창작 과정과 상담 신청은 소개 페이지에서 확인해 주세요.',enabled:true}],leads:[],trash:[],visits:0};
  const read=()=>{try{return JSON.parse(localStorage.getItem(KEY))||structuredClone(seed)}catch{return structuredClone(seed)}};
  const write=s=>localStorage.setItem(KEY,JSON.stringify(s));
  let revision=0, state=read();
  const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));
  window.fetch=async function(input,options={}){
    const url=String(input), path=url.split('/api/')[1]||''; const method=(options.method||'GET').toUpperCase();
    let body={}; try{body=options.body?JSON.parse(options.body):{}}catch{}
    if(path==='public') return json({admin:true,page:state.published||state.page});
    if(path==='visit'){state.visits++;write(state);return json({ok:true})}
    if(path==='admin/state'&&method==='GET') return json({config:{page:state.page,published:state.published,rules:state.rules},revision,leads:state.leads,trash:state.trash||[],leadOrder:[],orderRevision:-1,syncs:[],visits:state.visits||0});
    if(path==='admin/state'&&method==='PUT'){Object.assign(state,body.config||{});write(state);return json({revision:++revision})}
    if(path==='admin/links') return json({links:[],marketers:[],history:[]});
    if(path==='residence-options') return json({countries:[{code:'KR',name:'대한민국',zones:[{id:'Asia/Seoul'}]},{code:'US',name:'미국',zones:[{id:'America/Los_Angeles'},{id:'America/New_York'},{id:'America/Chicago'}]},{code:'JP',name:'일본',zones:[{id:'Asia/Tokyo'}]}],regions:{}});
    if(path==='inquiries'&&method==='POST'){state.leads.push({...body,id:body.id||crypto.randomUUID(),submittedAt:new Date().toISOString(),status:'신규 문의'});write(state);return json({ok:true})}
    if(path==='admin/leads'&&method==='PATCH'){const i=state.leads.findIndex(x=>x.id===body.id);if(i>=0)Object.assign(state.leads[i],body);write(state);return json({lead:state.leads[i]})}
    if(path==='admin/lead-history') return json({history:[]});
    if(path==='admin/lead-order') return json({ok:true});
    if(path==='admin/monday/check') return json({ready:false,summary:'GitHub Pages 로컬 모드에서는 Monday 연결을 사용할 수 없습니다.'});
    return json({ok:true});
  };
})();

