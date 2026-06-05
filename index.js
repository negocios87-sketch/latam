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
const COLABORADORES_URL  = process.env.COLABORADORES_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=1782440078&single=true&output=csv';
const METAS_URL          = process.env.METAS_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=0&single=true&output=csv';
const FERIADOS_URL       = process.env.FERIADOS_URL
  || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSvwO3Ag2f2cbkVgR1pJZp6fANQcbualGKlAG50fmOljuEGKZ1gJBbSAjRdO3SomXUEVQOWnTvlfHRd/pub?gid=1010928978&single=true&output=csv';

// ── Cache em memória ─────────────────────────────────────────
const _cache={};
async function cachedFetch(url,ttlMs=10*60*1000){
  const now=Date.now();
  if(_cache[url]&&(now-_cache[url].ts)<ttlMs)return _cache[url].data;
  const r=await fetch(url,{cache:'no-store'});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const data=await r.text();
  _cache[url]={data,ts:now};
  return data;
}

// Cache de deals do Pipedrive (TTL 5 min)
const _dealsCache={};
async function fetchByFilterCached(filterId,ttlMs=5*60*1000){
  const now=Date.now();
  if(_dealsCache[filterId]&&(now-_dealsCache[filterId].ts)<ttlMs){
    console.log(`[cache] deals filtro ${filterId} — hit`);
    return _dealsCache[filterId].data;
  }
  console.log(`[cache] deals filtro ${filterId} — miss, buscando...`);
  const data=await fetchByFilter(filterId);
  _dealsCache[filterId]={data,ts:now};
  return data;
}

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
    const txt=await cachedFetch(SCORE_RULES_URL).catch(()=>null);
    if(!txt)return[];
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

// ── Feriados ─────────────────────────────────────────────────
async function carregarFeriados(){
  try{
    const txt=await cachedFetch(FERIADOS_URL).catch(()=>null);
    if(!txt)return new Set();
    const linhas=txt.split(/\r?\n/).filter(l=>l.trim());
    const delim=linhas[0].includes('	')?'	':',';
    const feriados=new Set();
    linhas.slice(1).forEach(line=>{
      const cols=parseCsvLine(line,delim);
      const raw=String(cols[0]||'').trim(); // dd/mm/aaaa
      if(!raw)return;
      const parts=raw.split('/');
      if(parts.length===3){
        const [d,m,y]=parts;
        feriados.add(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`);
      }
    });
    return feriados;
  }catch(e){console.warn('Feriados failed:',e.message);return new Set();}
}

// Conta dias úteis (seg-sex excluindo feriados) entre duas datas inclusive
function diasUteis(de,ate,feriados){
  if(!feriados||typeof feriados.has!=='function')feriados=new Set();
  let count=0;
  const cur=new Date(de+'T00:00:00Z');
  const end=new Date(ate+'T00:00:00Z');
  while(cur<=end){
    const dow=cur.getUTCDay();
    const ymd=cur.toISOString().substring(0,10);
    if(dow>=1&&dow<=5&&!feriados.has(ymd))count++;
    cur.setUTCDate(cur.getUTCDate()+1);
  }
  return count;
}

// ── Colaboradores + Metas ─────────────────────────────────────
async function carregarMetasLatam(curYM){
  try{
    const[txtC,txtM]=await Promise.all([
      cachedFetch(COLABORADORES_URL).catch(()=>null),
      cachedFetch(METAS_URL).catch(()=>null),
    ]);
    if(!txtC||!txtM)return{total:0,porCloser:{},diasUteisDoMes:0};

    const [ano,mes]=curYM.split('-').map(Number);
    const mesNomes=['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesNome=mesNomes[mes-1];

    // Parse colaboradores → filtra LATAM pelo mês/ano de referência
    const linhasC=txtC.split(/\r?\n/).filter(l=>l.trim());
    const delimC=linhasC[0].includes('	')?'	':',';
    // Colunas: Nome, Área, Subarea, Cargo, Liderança, Equipe, Status, Mês Referencia, Ano Referencia, Email
    const colaboradoresLatam=new Set();
    linhasC.slice(1).forEach(line=>{
      const cols=parseCsvLine(line,delimC);
      const nome=String(cols[0]||'').trim();
      const subarea=normalizarTexto(cols[2]||'');
      const mesRefRaw=String(cols[7]||'').trim();
      const anoRef=parseInt(cols[8]||'0');
      if(!nome)return;
      // Aceita mês como número (5), nome (Maio) ou abreviação (Mai)
      const mesRefNum=parseInt(mesRefRaw);
      const mesRefNorm=normalizarTexto(mesRefRaw);
      const mesOk=mesRefNum===mes||mesRefNorm===normalizarTexto(mesNome)||mesRefNorm===normalizarTexto(mesNome).substring(0,3);
      if(subarea.includes('latam')&&mesOk&&anoRef===ano){
        colaboradoresLatam.add(nome);
      }
    });

    // Parse metas → filtra pelo mês/ano e nomes LATAM
    const linhasM=txtM.split(/\r?\n/).filter(l=>l.trim());
    const delimM=linhasM[0].includes('	')?'	':',';
    // Colunas: Ano, Mes, Dias Uteis, Nome, Meta de Reunioes, Meta Financeira, % de Rampagem
    const porCloser={};
    let totalMeta=0;
    let diasUteisDoMes=0;
    linhasM.slice(1).forEach(line=>{
      const cols=parseCsvLine(line,delimM);
      const anoMeta=parseInt(cols[0]||'0');
      const mesMetaRaw=String(cols[1]||'').trim();
      const duMes=parseInt(cols[2]||'0');
      const nome=String(cols[3]||'').trim();
      const metaFin=(()=>{
        let v=String(cols[5]||'0').trim().replace(/R\$\s*/g,'').trim();
        // Se tem vírgula: formato BR (1.234,56 ou 77.625,00 ou 77625)
        if(v.includes(','))v=v.replace(/\./g,'').replace(',','.');
        // Se não tem vírgula mas tem ponto com 3 dígitos depois: milhar (103.500)
        else if(/\.\d{3}$/.test(v))v=v.replace(/\./g,'');
        return parseFloat(v)||0;
      })();
      const ramp=parseFloat(String(cols[6]||'0').replace('%','').replace(',','.'))||100;
      const mesMetaNum=parseInt(mesMetaRaw);
      const mesMetaNorm=normalizarTexto(mesMetaRaw);
      const mesMetaOk=mesMetaNum===mes||mesMetaNorm===normalizarTexto(mesNome)||mesMetaNorm===normalizarTexto(mesNome).substring(0,3);
      if(anoMeta!==ano||!mesMetaOk)return;
      if(!colaboradoresLatam.has(nome))return;
      if(duMes>diasUteisDoMes)diasUteisDoMes=duMes;
      porCloser[nome]={meta:metaFin,vendas:0,receita:0};
      totalMeta+=metaFin;
    });

    // Adiciona colaboradores LATAM que não têm meta cadastrada
    colaboradoresLatam.forEach(nome=>{
      if(!porCloser[nome])porCloser[nome]={meta:0,vendas:0,receita:0};
    });

    return{total:totalMeta,porCloser,diasUteisDoMes};
  }catch(e){console.warn('Metas failed:',e.message);return{total:0,porCloser:{},diasUteisDoMes:0};}
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
// Converte datetime UTC do Pipedrive para data no fuso America/Sao_Paulo (UTC-3)
function toLocalDate(d){
  if(!d)return null;
  const dt=new Date(String(d).replace(' ','T').replace(/(\.\d+)?$/, 'Z').replace(/ZZ$/,'Z'));
  if(isNaN(dt))return String(d).substring(0,10);
  return dt.toLocaleDateString('sv-SE',{timeZone:'America/Sao_Paulo'}); // sv-SE = YYYY-MM-DD
}
const toYM  = d=>d?toLocalDate(d)?.substring(0,7):null;
const toYMD = d=>d?toLocalDate(d):null;
function weekStart(dateStr){
  if(!dateStr)return null;
  // Semana Seg→Dom: volta até a segunda-feira da semana
  const d=new Date(String(dateStr).substring(0,10)+'T00:00:00Z');
  const day=d.getUTCDay(); // 0=Dom,1=Seg,...,6=Sab
  d.setUTCDate(d.getUTCDate()-((day+6)%7)); // recua até segunda
  return d.toISOString().substring(0,10);
}
function getWeeks(n=8){
  const now=new Date();
  // Acha o último domingo completo
  const day=now.getUTCDay(); // 0=Dom
  const lastSun=new Date(now);
  // Se hoje é domingo, a semana atual ainda não acabou → volta 1 semana
  const daysToLastSun = day===0 ? 7 : day;
  lastSun.setUTCDate(now.getUTCDate()-daysToLastSun);
  lastSun.setUTCHours(0,0,0,0);
  // Segunda-feira da semana que terminou nesse domingo
  const lastMon=new Date(lastSun);
  lastMon.setUTCDate(lastSun.getUTCDate()-6);
  const weeks=[];
  for(let i=n-1;i>=0;i--){
    const d=new Date(lastMon);
    d.setUTCDate(lastMon.getUTCDate()-i*7);
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
    const curYM=req.query.mes&&/^\d{4}-\d{2}$/.test(req.query.mes)
      ?req.query.mes
      :'2026-05';

    console.log('[report] curYM:', curYM);
    const[allDeals,regrasScore,feriados,metasData]=await Promise.all([
      fetchByFilterCached(FILTER_LATAM).catch(e=>{console.error('fetchByFilter:',e.message);throw e;}),
      carregarRegrasScore().catch(e=>{console.error('regrasScore:',e.message);return[];}),
      carregarFeriados().catch(e=>{console.error('feriados:',e.message);return new Set();}),
      carregarMetasLatam(curYM).catch(e=>{console.error('metas:',e.message);return{total:0,porCloser:{},diasUteisDoMes:0};}),
    ]);
    console.log('[report] deals:', allDeals.length, 'metas total:', metasData.total, 'closers:', Object.keys(metasData.porCloser||{}).length, 'porCloser:', JSON.stringify(Object.keys(metasData.porCloser||{})));
    // Garante estrutura mínima antes dos loops
    const metasDataSafe={total:0,porCloser:{},diasUteisDoMes:0,...(metasData||{})};
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
    const G={deals:[],porDia:{},porSemana:{},origemTemporal:{},vendsPorProprietario:{}};
    const P={
      total:0,porDia:{},porSemana:{},origemTemporal:{},deals:[],
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
          const proprietario=deal.owner_name||(deal.user_id&&deal.user_id.name)||'—';
          G.deals.push({
            id:deal.id,titulo:deal.title||'—',pais,
            dataGanho:wonD,valor:val,proprietario,
            addTime:toYMD(deal.add_time),
          });
          // Acumula no closer
          if(metasData.porCloser[proprietario]){
            metasDataSafe.porCloser[proprietario].vendas++;
            metasDataSafe.porCloser[proprietario].receita+=val;
          }
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

          P.deals.push({
            id:deal.id,
            addTime:toYMD(deal.add_time),
            lostTime:lostD,
            proprietario:deal.owner_name||(deal.user_id&&deal.user_id.name)||'—',
            pais,motivo,
          });
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

    // ── Dias úteis MTD ────────────────────────────────────────
    const metaTotal=metasDataSafe.total||0;
    const [cyear,cmonth]=curYM.split('-');
    const inicioMes=`${curYM}-01`;
    const hoje=new Date();
    const hojeStr=hoje.toISOString().substring(0,10);
    // Se o mês selecionado é futuro, duMTD=0; se passado, usa último dia do mês
    const ultimoDiaMes=new Date(Date.UTC(parseInt(cyear),parseInt(cmonth),0)).toISOString().substring(0,10);
    const ateMTD=hojeStr<inicioMes?'':hojeStr>ultimoDiaMes?ultimoDiaMes:hojeStr;
    const duMTD=ateMTD?diasUteis(inicioMes,ateMTD,feriados):0;
    const duMes=metasDataSafe.diasUteisDoMes||diasUteis(inicioMes,ultimoDiaMes,feriados);
    const metaMTD=duMes>0?metaTotal*(duMTD/duMes):0;

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
        metas:{
          total:metaTotal,
          mtd:metaMTD,
          duMes,duMTD,
          receitaAtual:G.deals.reduce((s,d)=>s+(d.valor||0),0),
          vendsPorProprietario:G.vendsPorProprietario,
          porCloser:Object.entries(metasDataSafe.porCloser)
            .sort((a,b)=>b[1].receita-a[1].receita)
            .map(([nome,m])=>({
              nome,
              meta:m.meta,
              vendas:m.vendas,
              receita:m.receita,
              pctMeta:m.meta>0?+((m.receita/m.meta)*100).toFixed(1):0,
              pctMTD:metaMTD>0&&m.meta>0?+((m.receita/(m.meta*(duMTD/duMes||1)))*100).toFixed(1):0,
            })),
        },
      },

      perdidos:{
        total:P.total,
        deals:P.deals||[],
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


// ── Histórico (endpoint separado, lazy) ──────────────────────
app.get('/api/historico', async(req,res)=>{
  if(!API_TOKEN)return res.status(500).json({ok:false,error:'sem token'});
  try{
    const[allDeals,regrasScore]=await Promise.all([
      fetchByFilterCached(FILTER_LATAM),
      carregarRegrasScore(),
    ]);

    const faixas=buildFaixas(regrasScore);
    const C_mes={},C_chile={},C_mexico={};
    const G_mes={};
    const P_mes={};
    const AX={motivoMes:{},motivoRenda:{},mesRenda:{}};

    for(const deal of allDeals){
      const pais=getPais(deal);
      const addYM=toYM(deal.add_time);
      const pc_mes=pais==='CHILE'?C_chile:C_mexico;

      // Criados por mês
      if(addYM){
        C_mes[addYM]=(C_mes[addYM]||0)+1;
        pc_mes[addYM]=(pc_mes[addYM]||0)+1;
      }

      // Ganhos por mês
      if(deal.status==='won'&&deal.won_time){
        const wonYM=toYM(deal.won_time);
        const val=parseFloat(deal.value||0);
        const proprietario=deal.owner_name||(deal.user_id&&deal.user_id.name)||'—';
        if(wonYM&&val>0){
          if(!G_mes[wonYM])G_mes[wonYM]={t:0,r:0,deals:[]};
          G_mes[wonYM].t++;G_mes[wonYM].r+=val;
          G_mes[wonYM].deals.push({
            id:deal.id,valor:val,proprietario,pais,
            dataGanho:toYMD(deal.won_time),
            addTime:toYMD(deal.add_time),
            titulo:deal.title||'—',
          });
        }
      }

      // Perdidos por mês
      if(deal.status==='lost'&&deal.lost_time){
        const lostYM=toYM(deal.lost_time);
        const motivo=deal.lost_reason?.trim()||'Não informado';
        const rendaLeg=getRendaLegenda(deal,regrasScore);
        const ppKey=pais==='CHILE'?'chile':'mexico';

        if(lostYM){
          if(!P_mes[lostYM])P_mes[lostYM]={total:0,chile:{total:0,motivos:{}},mexico:{total:0,motivos:{}}};
          P_mes[lostYM].total++;
          P_mes[lostYM][ppKey].total++;
          P_mes[lostYM][ppKey].motivos[motivo]=(P_mes[lostYM][ppKey].motivos[motivo]||0)+1;
        }

        // AX
        if(lostYM){
          if(!AX.motivoMes[motivo])AX.motivoMes[motivo]={};
          AX.motivoMes[motivo][lostYM]=(AX.motivoMes[motivo][lostYM]||0)+1;
        }
        if(!AX.motivoRenda[motivo])AX.motivoRenda[motivo]={};
        AX.motivoRenda[motivo][rendaLeg]=(AX.motivoRenda[motivo][rendaLeg]||0)+1;
        if(addYM){
          if(!AX.mesRenda[addYM])AX.mesRenda[addYM]={};
          AX.mesRenda[addYM][rendaLeg]=(AX.mesRenda[addYM][rendaLeg]||0)+1;
        }
      }
    }

    // Serializa análises
    const motivoTotais={};
    Object.entries(AX.motivoMes).forEach(([m,meses])=>{
      motivoTotais[m]=Object.values(meses).reduce((s,v)=>s+v,0);
    });
    const top10Motivos=Object.entries(motivoTotais).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([m])=>m);
    const mesesDisp=[...new Set(Object.values(AX.motivoMes).flatMap(m=>Object.keys(m)))].sort();
    const faixasSet=new Set([...faixas.map(f=>f.legenda),'Não informado']);
    const faixasDisp=[...faixasSet];
    const meses=[...new Set([...Object.keys(C_mes),...Object.keys(G_mes),...Object.keys(P_mes)])].sort();

    res.json({
      ok:true,
      historico:{
        meses,
        criados:{total:C_mes,chile:C_chile,mexico:C_mexico},
        ganhos:G_mes,
        perdidos:P_mes,
      },
      analises:{
        top10Motivos,mesesDisp,faixasDisp,
        motivoMes:Object.fromEntries(top10Motivos.map(m=>[m,AX.motivoMes[m]||{}])),
        motivoRenda:Object.fromEntries(top10Motivos.map(m=>[m,AX.motivoRenda[m]||{}])),
        mesRenda:AX.mesRenda,
        mesesCriacao:[...new Set(Object.keys(AX.mesRenda))].sort(),
      },
    });
  }catch(e){
    console.error('[/api/historico]',e);
    res.status(500).json({ok:false,error:e.message});
  }
});

// ── DEBUG: ver valores reais do campo renda (mês atual) ──────
app.get('/api/debug-renda', async(req,res)=>{
  if(!API_TOKEN)return res.status(500).json({ok:false,error:'sem token'});
  try{
    const [allDeals, regras] = await Promise.all([
      fetchByFilter(FILTER_LATAM),
      carregarRegrasScore(),
    ]);
    const curYM=new Date().toISOString().substring(0,7);
    const dealsDoMes=allDeals.filter(d=>toYM(d.add_time)===curYM);
    // Conta frequência de cada valor bruto do campo renda
    const freq={};
    for(const deal of dealsDoMes){
      const raw=String(deal[FIELD_RENDA]||'(vazio)').trim();
      freq[raw]=(freq[raw]||0)+1;
    }
    const resultado=Object.entries(freq)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,50)
      .map(([raw,count])=>{
        const norm=normalizarTexto(raw);
        const match=regras.find(r=>r.tipo==='renda'&&r.pais==='latam'&&r.contemNorm&&norm.includes(r.contemNorm));
        return{raw,norm,count,match:match?match.legenda:'❌ SEM MATCH',contemUsado:match?match.contem:null};
      });
    const semMatch=Object.values(freq).reduce((s,v)=>s+v,0);
    const comMatch=resultado.filter(r=>r.match!=='❌ SEM MATCH').reduce((s,r)=>s+r.count,0);
    res.json({ok:true,mes:curYM,totalDealsNoMes:dealsDoMes.length,regrasLatam:regras.filter(r=>r.tipo==='renda'&&r.pais==='latam').length,comMatch,semMatch:semMatch-comMatch,resultado});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});


// ── DEBUG: metas raw ─────────────────────────────────────────
app.get('/api/debug-metas', async(req,res)=>{
  if(!API_TOKEN)return res.status(500).json({ok:false,error:'sem token'});
  try{
    const txt=await cachedFetch(METAS_URL).catch(()=>null);
    if(!txt)return res.status(500).json({ok:false,error:'falha ao buscar metas'});
    const linhas=txt.split(/\r?\n/).filter(l=>l.trim());
    const delim=linhas[0].includes('\t')?'\t':',';
    // Filtra só maio/2026
    const rows=linhas.filter(l=>{
      const cols=parseCsvLine(l,delim);
      return cols[0]==='2026'&&cols[1]==='5';
    }).map(line=>{
      const cols=parseCsvLine(line,delim);
      let v=String(cols[5]||'0').trim().replace(/R\$\s*/g,'').trim();
      if(v.includes(','))v=v.replace(/\./g,'').replace(',','.');
      else if(/\.\d{3}$/.test(v))v=v.replace(/\./g,'');
      return{nome:cols[3],col5raw:cols[5],vProcessado:v,resultado:parseFloat(v)||0};
    });
    res.json({ok:true,totalLinhas2026maio:rows.length,rows});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

if(process.env.NODE_ENV!=='production')app.listen(PORT,()=>console.log(`✓ Porta ${PORT}`));
module.exports=app;
