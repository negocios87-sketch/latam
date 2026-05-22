const express = require('express');
const path    = require('path');
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const API_TOKEN       = process.env.PIPEDRIVE_TOKEN;
const ORG             = process.env.PIPEDRIVE_ORG   || 'boardacademy';
const FILTER_LATAM    = process.env.FILTER_LATAM    || '1654189';

const PRODUCT_FIELD      = '8bdce76ba66f0fed0280918a4845190c92899ed5';
const REFERIDO_FIELD     = '54fc9258843cdf7ea126b6c5aca9d4dc93a3a718';
const FIELD_RENDA        = 'c95b2c453828853409c0a1f5d5f1a6ab30eebebf';
const SCORE_RULES_URL    = process.env.SCORE_RULES_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=422517996&single=true&output=csv';

// ── País ──────────────────────────────────────────────────────
function getPais(deal){
  return String(deal[PRODUCT_FIELD]||'').toLowerCase().includes('chile')?'CHILE':'MEXICO';
}
function isReferido(deal){
  return String(deal[REFERIDO_FIELD]||'').toLowerCase().includes('indicacao-comercial');
}

// ── Score por renda (LATAM only) ──────────────────────────────
function normalizarTexto(v){
  return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/_/g,' ').replace(/\s+/g,' ').trim();
}
function parseCsvLine(line,delim){
  const out=[];let cur='';let inQ=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i],nx=line[i+1];
    if(ch==='"'&&inQ&&nx==='"'){cur+='"';i++;continue;}
    if(ch==='"'){inQ=!inQ;continue;}
    if(ch===delim&&!inQ){out.push(cur);cur='';continue;}
    cur+=ch;
  }
  out.push(cur);
  return out.map(x=>x.trim());
}
function parsePontuacao(v){
  const n=parseFloat(String(v||'').replace(',','.'));
  return Number.isFinite(n)?n:null;
}

async function carregarRegrasScore(){
  try{
    const r=await fetch(SCORE_RULES_URL,{cache:'no-store'});
    if(!r.ok)return[];
    const txt=await r.text();
    const linhas=txt.split(/\r?\n/).filter(l=>l.trim());
    if(!linhas.length)return[];
    const delim=linhas[0].includes('\t')?'\t':',';
    // Colunas: tipo, contem, pontuacao, país, legenda
    return linhas.slice(1).map(line=>{
      const cols=parseCsvLine(line,delim);
      return{
        tipo:      normalizarTexto(cols[0]),
        contem:    String(cols[1]||'').trim(),
        contemNorm:normalizarTexto(cols[1]),
        pontuacao: parsePontuacao(cols[2]),
        pais:      normalizarTexto(cols[3]),
        legenda:   String(cols[4]||'').trim(),
      };
    }).filter(r=>r.tipo&&r.pontuacao!==null);
  }catch(e){console.warn('Score rules failed:',e.message);return[];}
}

// Retorna legenda da faixa de renda do deal (filtra LATAM)
function getRendaLegenda(deal,regras){
  const textoNorm=normalizarTexto(deal[FIELD_RENDA]);
  if(!textoNorm)return'Não informado';
  const match=regras.find(r=>
    r.tipo==='renda'&&
    r.pais==='latam'&&
    r.contemNorm&&
    textoNorm.includes(r.contemNorm)
  );
  return match?(match.legenda||match.contem):'Não informado';
}

// Monta lista de faixas únicas ordenadas por pontuacao asc
function buildFaixas(regras){
  const seen=new Map();
  regras
    .filter(r=>r.tipo==='renda'&&r.pais==='latam'&&r.legenda)
    .forEach(r=>{if(!seen.has(r.legenda))seen.set(r.legenda,r.pontuacao);});
  const faixas=[...seen.entries()]
    .sort((a,b)=>a[1]-b[1])
    .map(([legenda,pontuacao])=>({legenda,pontuacao}));
  // Garante "Não informado" no fim
  faixas.push({legenda:'Não informado',pontuacao:-1});
  return faixas;
}
function emptyFaixas(faixas){return Object.fromEntries(faixas.map(f=>[f.legenda,0]));}

// ── Date utils ────────────────────────────────────────────────
const toYM  = d=>d?String(d).substring(0,7):null;
const toYMD = d=>d?String(d).substring(0,10):null;
function weekStart(dateStr){
  if(!dateStr)return null;
  const d=new Date(String(dateStr).substring(0,10)+'T00:00:00Z');
  const day=d.getUTCDay();
  d.setUTCDate(d.getUTCDate()-((day-4+7)%7));
  return d.toISOString().substring(0,10);
}
function getWeeks(n=8){
  const now=new Date();
  const day=now.getUTCDay();
  const currThu=new Date(now);
  currThu.setUTCDate(now.getUTCDate()-((day-4+7)%7));
  currThu.setUTCHours(0,0,0,0);
  const base=new Date(currThu);
  base.setUTCDate(currThu.getUTCDate()-7);
  const weeks=[];
  for(let i=n-1;i>=0;i--){
    const d=new Date(base);
    d.setUTCDate(base.getUTCDate()-i*7);
    weeks.push(d.toISOString().substring(0,10));
  }
  return weeks;
}
function addMonths(ym,n){
  const[y,m]=ym.split('-').map(Number);
  const d=new Date(y,m-1+n,1);
  return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// ── Pipedrive ─────────────────────────────────────────────────
const BASE=`https://${ORG}.pipedrive.com/api/v1`;
async function pipeGet(ep){
  const sep=ep.includes('?')?'&':'?';
  const r=await fetch(`${BASE}${ep}${sep}api_token=${API_TOKEN}`);
  if(!r.ok)throw new Error(`Pipedrive ${r.status} → ${ep}`);
  return r.json();
}
async function fetchByFilter(filterId){
  const all=[];let start=0;
  while(true){
    const j=await pipeGet(`/deals?filter_id=${filterId}&status=all&limit=500&start=${start}`);
    (j.data||[]).forEach(d=>all.push(d));
    if(!j.additional_data?.pagination?.more_items_in_collection)break;
    start+=500;
  }
  return all;
}

// ── Report ────────────────────────────────────────────────────
app.get('/api/report', async(req,res)=>{
  if(!API_TOKEN)return res.status(500).json({ok:false,error:'PIPEDRIVE_TOKEN não configurado.'});
  try{
    const[allDeals,regrasScore]=await Promise.all([
      fetchByFilter(FILTER_LATAM),
      carregarRegrasScore(),
    ]);

    const now=new Date();
    const curYM=now.toISOString().substring(0,7);
    const prevYM=addMonths(curYM,-1);
    const prev2YM=addMonths(curYM,-2);
    const weeks=getWeeks(8);
    const wSet=new Set(weeks);
    const[year,month]=curYM.split('-').map(Number);
    const daysInMonth=new Date(year,month,0).getDate();
    const allDays=Array.from({length:daysInMonth},(_,i)=>`${curYM}-${String(i+1).padStart(2,'0')}`);

    const faixas=buildFaixas(regrasScore);

    const C={
      total:0,porDia:{},porSemana:{},
      chile:{total:0,st:{a:0,g:0,p:0},scoreFaixas:emptyFaixas(faixas),porDia:{},porSemana:{}},
      mexico:{total:0,st:{a:0,g:0,p:0},scoreFaixas:emptyFaixas(faixas),porDia:{},porSemana:{}},
      referidos:{total:0,a:0,g:0,p:0},
    };
    const G={deals:[],porDia:{},porSemana:{},origemTemporal:{}};
    const P={
      total:0,porDia:{},porSemana:{},origemTemporal:{},
      chile:{total:0,motivos:{},scoreFaixas:emptyFaixas(faixas)},
      mexico:{total:0,motivos:{},scoreFaixas:emptyFaixas(faixas)},
    };

    for(const deal of allDeals){
      const pais=getPais(deal);
      const ref=isReferido(deal);
      const addYM=toYM(deal.add_time);
      const addW=weekStart(deal.add_time);
      const pc=pais==='CHILE'?C.chile:C.mexico;

      // ── CRIADOS ───────────────────────────────────────────
      if(addYM===curYM){
        const addD=toYMD(deal.add_time);
        C.total++;pc.total++;
        C.porDia[addD]=(C.porDia[addD]||0)+1;
        pc.porDia[addD]=(pc.porDia[addD]||0)+1;
        if(deal.status==='open')pc.st.a++;
        else if(deal.status==='won')pc.st.g++;
        else if(deal.status==='lost')pc.st.p++;
        const legenda=getRendaLegenda(deal,regrasScore);
        if(pc.scoreFaixas[legenda]!==undefined)pc.scoreFaixas[legenda]++;
        else pc.scoreFaixas['Não informado']=(pc.scoreFaixas['Não informado']||0)+1;
        if(ref){
          C.referidos.total++;
          if(deal.status==='open')C.referidos.a++;
          else if(deal.status==='won')C.referidos.g++;
          else if(deal.status==='lost')C.referidos.p++;
        }
      }
      if(addW&&wSet.has(addW)){
        C.porSemana[addW]=(C.porSemana[addW]||0)+1;
        pc.porSemana[addW]=(pc.porSemana[addW]||0)+1;
      }

      // ── GANHOS ────────────────────────────────────────────
      if(deal.status==='won'&&deal.won_time){
        const wonYM=toYM(deal.won_time);
        const wonW=weekStart(deal.won_time);
        const wonD=toYMD(deal.won_time);
        const val=parseFloat(deal.value||0);
        if(wonYM===curYM&&val>0){
          let tempCat='antes';
          if(addYM===curYM)tempCat='cur';
          else if(addYM===prevYM)tempCat='prev';
          else if(addYM===prev2YM)tempCat='prev2';
          G.deals.push({
            id:deal.id,titulo:deal.title||'—',pais,
            dataGanho:wonD,valor:val,
            proprietario:deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
            addTime:toYMD(deal.add_time),
          });
          if(!G.porDia[wonD])G.porDia[wonD]={t:0,r:0};
          G.porDia[wonD].t++;G.porDia[wonD].r+=val;
          G.origemTemporal[tempCat]=(G.origemTemporal[tempCat]||0)+1;
        }
        if(wonW&&wSet.has(wonW)){
          if(!G.porSemana[wonW])G.porSemana[wonW]={t:0,r:0};
          G.porSemana[wonW].t++;G.porSemana[wonW].r+=val;
        }
      }

      // ── PERDIDOS ──────────────────────────────────────────
      if(deal.status==='lost'&&deal.lost_time){
        const lostYM=toYM(deal.lost_time);
        const lostW=weekStart(deal.lost_time);
        const lostD=toYMD(deal.lost_time);
        const pp=pais==='CHILE'?P.chile:P.mexico;
        if(lostYM===curYM){
          const motivo=deal.lost_reason?.trim()||'Não informado';
          P.total++;pp.total++;
          P.porDia[lostD]=(P.porDia[lostD]||0)+1;
          pp.motivos[motivo]=(pp.motivos[motivo]||0)+1;
          const legenda=getRendaLegenda(deal,regrasScore);
          if(pp.scoreFaixas[legenda]!==undefined)pp.scoreFaixas[legenda]++;
          else pp.scoreFaixas['Não informado']=(pp.scoreFaixas['Não informado']||0)+1;
          let tempCat='antes';
          if(addYM===curYM)tempCat='cur';
          else if(addYM===prevYM)tempCat='prev';
          else if(addYM===prev2YM)tempCat='prev2';
          P.origemTemporal[tempCat]=(P.origemTemporal[tempCat]||0)+1;
        }
        if(lostW&&wSet.has(lostW))P.porSemana[lostW]=(P.porSemana[lostW]||0)+1;
      }
    }

    // ── Serialização ──────────────────────────────────────────
    const MES_NOMES=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const ymLabel=ym=>{const[y,m]=ym.split('-');return MES_NOMES[+m-1]+'/'+y.slice(2);};
    const serFaixas=(sf,total)=>faixas.map(f=>{
      const v=sf[f.legenda]||0;
      return{label:f.legenda,v,pct:total>0?+((v/total)*100).toFixed(1):0};
    });
    const origTemporalSer=(ot,total)=>[
      {label:`Mês atual (${ymLabel(curYM)})`,v:ot.cur||0,  pct:total>0?Math.round((ot.cur||0)/total*100):0},
      {label:ymLabel(prevYM),                v:ot.prev||0, pct:total>0?Math.round((ot.prev||0)/total*100):0},
      {label:ymLabel(prev2YM),               v:ot.prev2||0,pct:total>0?Math.round((ot.prev2||0)/total*100):0},
      {label:`Antes de ${ymLabel(prev2YM)}`, v:ot.antes||0,pct:total>0?Math.round((ot.antes||0)/total*100):0},
    ];

    res.json({
      ok:true,mes:curYM,updatedAt:new Date().toISOString(),
      faixasLabels:faixas.map(f=>f.legenda),
      criados:{
        total:C.total,
        mediaDia:allDays.length?+(C.total/allDays.length).toFixed(1):0,
        chile:{total:C.chile.total,status:C.chile.st,pct:C.total>0?Math.round(C.chile.total/C.total*100):0,scoreFaixas:serFaixas(C.chile.scoreFaixas,C.chile.total)},
        mexico:{total:C.mexico.total,status:C.mexico.st,pct:C.total>0?Math.round(C.mexico.total/C.total*100):0,scoreFaixas:serFaixas(C.mexico.scoreFaixas,C.mexico.total)},
        referidos:C.referidos,
        porDia:allDays.map(d=>({d,v:C.porDia[d]||0,chile:C.chile.porDia[d]||0,mexico:C.mexico.porDia[d]||0})),
        porSemana:weeks.map(w=>({w,v:C.porSemana[w]||0,chile:C.chile.porSemana[w]||0,mexico:C.mexico.porSemana[w]||0})),
      },
      ganhos:{
        porDia:allDays.map(d=>({d,v:G.porDia[d]?.t||0,r:G.porDia[d]?.r||0})),
        porSemana:weeks.map(w=>({w,v:G.porSemana[w]?.t||0,r:G.porSemana[w]?.r||0})),
        origemTemporal:origTemporalSer(G.origemTemporal,G.deals.length),
        deals:G.deals,
      },
      perdidos:{
        total:P.total,
        mediaDia:allDays.length?+(P.total/allDays.length).toFixed(1):0,
        chile:{total:P.chile.total,pct:P.total>0?Math.round(P.chile.total/P.total*100):0,motivos:Object.entries(P.chile.motivos).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([m,c])=>({m,c,pct:P.chile.total?Math.round(c/P.chile.total*100):0})),scoreFaixas:serFaixas(P.chile.scoreFaixas,P.chile.total)},
        mexico:{total:P.mexico.total,pct:P.total>0?Math.round(P.mexico.total/P.total*100):0,motivos:Object.entries(P.mexico.motivos).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([m,c])=>({m,c,pct:P.mexico.total?Math.round(c/P.mexico.total*100):0})),scoreFaixas:serFaixas(P.mexico.scoreFaixas,P.mexico.total)},
        porDia:allDays.map(d=>({d,v:P.porDia[d]||0})),
        porSemana:weeks.map(w=>({w,v:P.porSemana[w]||0})),
        origemTemporal:origTemporalSer(P.origemTemporal,P.total),
      },
    });
  }catch(e){
    console.error('[/api/report]',e);
    res.status(500).json({ok:false,error:e.message});
  }
});


// ── DEBUG: ver valores reais do campo renda ──────────────────
app.get('/api/debug-renda', async(req,res)=>{
  if(!API_TOKEN)return res.status(500).json({ok:false,error:'sem token'});
  try{
    const [allDeals, regras] = await Promise.all([
      fetchByFilter(FILTER_LATAM),
      carregarRegrasScore(),
    ]);
    // Conta frequência de cada valor bruto do campo renda
    const freq={};
    for(const deal of allDeals.slice(0,500)){
      const raw=String(deal[FIELD_RENDA]||'(vazio)').trim();
      freq[raw]=(freq[raw]||0)+1;
    }
    // Mostra top 40 valores + se bateu no DEPARA
    const resultado=Object.entries(freq)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,40)
      .map(([raw,count])=>{
        const norm=normalizarTexto(raw);
        const match=regras.find(r=>r.tipo==='renda'&&r.pais==='latam'&&r.contemNorm&&norm.includes(r.contemNorm));
        return{raw,norm,count,match:match?match.legenda:'❌ SEM MATCH',contemUsado:match?match.contem:null};
      });
    res.json({ok:true,totalDeals:allDeals.length,regrasLatam:regras.filter(r=>r.tipo==='renda'&&r.pais==='latam').length,resultado});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

if(process.env.NODE_ENV!=='production')app.listen(PORT,()=>console.log(`✓ Porta ${PORT}`));
module.exports=app;
