"""Painel LATAM · Board Academy — backend Python ligado à CRN.

Regras: biblioteca crn (GitHub negocios87-sketch/CRN, branch main). Nada de regra reimplementada aqui.
Variáveis de ambiente (Vercel): PIPEDRIVE_TOKEN, CRN_GITHUB_TOKEN, URL_COLAB, URL_METAS, URL_FERIADOS, TURMAS_URL.

Parâmetros (carimbo):
- Recorte: funil LATAM (LT1), Chile e México juntos.
- Leads: data da última aplicação (P10 = aplicacao).
- Valor: bruto (M2-B); multiplicador (M2-M) exibido como informação complementar.
- Squad/meta: Colab e Metas do mês (P8 = colab_do_mes).
- Datas: America/Sao_Paulo (R0).
"""
import io
import os

# ── CRN: baixada do GitHub quando o painel liga ───────────────
# A Vercel não repassa o token para o instalador do build, então a CRN não entra pelo
# requirements.txt. O painel baixa a versão atual da main (com o token, que em tempo de
# execução funciona) e carrega. Cada vez que o painel liga, pega as regras mais recentes.
# No computador, se a crn já estiver instalada (instalar.bat), usa a instalada.
def _carregar_crn():
    import importlib.util
    import shutil
    import sys
    import tarfile
    import tempfile
    if importlib.util.find_spec("crn") is not None:
        return None
    import requests
    token = (os.environ.get("CRN_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or "").strip()
    if not token:
        raise RuntimeError("CRN_GITHUB_TOKEN não está nas Environment Variables da Vercel.")
    r = requests.get("https://api.github.com/repos/negocios87-sketch/CRN/tarball/main",
                     headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"},
                     timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"Não consegui baixar a CRN do GitHub (HTTP {r.status_code}). Confira o CRN_GITHUB_TOKEN.")
    base = tempfile.mkdtemp(prefix="crn_")
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tar:
        tar.extractall(base, filter="data")
    raiz = os.path.join(base, os.listdir(base)[0])          # negocios87-sketch-CRN-<commit>
    destino = os.path.join(base, "pacote", "crn")
    shutil.copytree(os.path.join(raiz, "lib"), destino)     # mesmo mapa do pyproject da CRN
    shutil.copytree(os.path.join(raiz, "config"), os.path.join(destino, "config"))
    sys.path.insert(0, os.path.join(base, "pacote"))
    return os.path.basename(raiz).rsplit("-", 1)[-1][:7]   # commit que entrou

_COMMIT_CRN = _carregar_crn()

import crn
if _COMMIT_CRN:
    crn.versao = lambda: _COMMIT_CRN                        # carimbo mostra o commit carregado

# ── imports do painel ─────────────────────────────────────────
import calendar
import threading
import time
import traceback
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, time as hora

from flask import Flask, jsonify, request, send_from_directory

from crn.base import fontes, pipedrive
from crn.base.config import campo, config
from crn.base.fuso import TZ_BR, UTC, agora_brasil, data_brasil, hoje_brasil, no_mes, no_periodo
from crn.base.texto import cf, dono_id, norm, numero
from crn.regras import (g1_ganho_automatico, ld1_universo_leads, lt1_latam, m1_ganho_closer,
                        m2_faturamento_closer, m3_atingimento_closer, m8_deal_perdido, p1_motivo_perda,
                        rf1_referidos, sc3_score_dados, t1_mtd_closer)

# Mapear nomes antigos de variável para os nomes da CRN (não muda a configuração da Vercel)
for _antigo, _novo in (("PIPEDRIVE_API_TOKEN", "PIPEDRIVE_TOKEN"), ("COLABORADORES_URL", "URL_COLAB"),
                       ("METAS_URL", "URL_METAS"), ("FERIADOS_URL", "URL_FERIADOS")):
    if os.environ.get(_antigo) and not os.environ.get(_novo):
        os.environ.setdefault(_novo, os.environ[_antigo])

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__, static_folder=None)

FUNIL_LATAM = config()["funis"]["latam"][0]
CAMPOS_BUSCA = [campo(n) for n in ("produto", "multiplicador", "renda", "cargo", "ultima_aplicacao",
                                   "tag_aplicacao_v2")]
NAO_INFORMADO = "Não informado"
MES_NOMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
MESES_HISTORICO = 12

# Faixas de renda da SC3 (equivalência BRL) exibidas com o texto em pesos que o lead LATAM responde.
# Só rótulo de exibição: a faixa em si vem da SC3.
ROTULO_RENDA = {
    "ate 10 mil": "Até 35 mil MXN",
    "10 a 15 mil": "35 a 60 mil MXN",
    "15 a 20 mil": "60 a 80 mil MXN",
    "20 a 25 mil": "80 a 100 mil MXN",
    "25 a 30 mil": "100 a 120 mil MXN",
    "30 a 40 mil": "120 a 160 mil MXN",
    "40 a 50 mil": "160 a 200 mil MXN",
    "mais de 50 mil": "Mais de 200 mil MXN",
}


# ── cache simples em memória (por instância) ─────────────────
_cache: dict = {}
_trava = threading.Lock()


def _cacheado(chave, ttl, fn):
    agora = time.time()
    with _trava:
        if chave in _cache and agora - _cache[chave][0] < ttl:
            return _cache[chave][1]
    valor = fn()
    with _trava:
        _cache[chave] = (agora, valor)
    return valor


# ── busca no Pipedrive ────────────────────────────────────────
def _utc(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def deals_latam_atualizados(desde: date) -> list[dict]:
    """Deals do funil LATAM atualizados desde `desde` (00:00 Brasília). Todo ganho, perda ou aplicação
    a partir dessa data mexe no deal, então essa busca cobre ganhos, perdidos e leads do período.
    A janela é fatiada por update_time e buscada em paralelo (só GET), para caber no tempo da Vercel."""
    ini = datetime.combine(desde, hora(0), TZ_BR)
    fim = agora_brasil() + timedelta(minutes=5)
    passo = timedelta(days=10)
    janelas, a = [], ini
    while a < fim:
        b = min(a + passo, fim)
        janelas.append((a, b))
        a = b

    def busca(j):
        return pipedrive.deals(pipeline_id=FUNIL_LATAM, status="open,won,lost", updated_since=_utc(j[0]),
                               updated_until=_utc(j[1]), custom_fields=",".join(CAMPOS_BUSCA))

    vistos = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        for lote in ex.map(busca, janelas):
            for d in lote:
                if lt1_latam.eh_latam(d):
                    vistos[d["id"]] = d
    return list(vistos.values())


def usuarios() -> dict:
    return _cacheado("usuarios", 3600, pipedrive.usuarios)


# ── utilidades de data ────────────────────────────────────────
def ym(d: date | None) -> str | None:
    return f"{d.year}-{d.month:02d}" if d else None


def add_meses(ano: int, mes: int, n: int) -> tuple[int, int]:
    t = ano * 12 + (mes - 1) + n
    return t // 12, t % 12 + 1


def rotulo_mes(a: str) -> str:
    y, m = a.split("-")
    return f"{MES_NOMES[int(m) - 1]}/{y[2:]}"


def inicio_semana(d: date) -> date:
    return d - timedelta(days=d.weekday())


def ultimas_semanas(n: int = 8) -> list[date]:
    """Segundas-feiras das últimas n semanas completas (seg→dom), pelo dia de hoje em Brasília."""
    hoje = hoje_brasil()
    ultima_seg = inicio_semana(hoje) - timedelta(days=7)
    return [ultima_seg - timedelta(days=7 * i) for i in range(n - 1, -1, -1)]


# ── leituras com regra da CRN ─────────────────────────────────
def data_aplicacao(d: dict) -> date | None:
    return ld1_universo_leads.data_do_lead(d, "aplicacao")


def faixa_renda(d: dict) -> str:
    c = sc3_score_dados.classificar("renda", cf(d, campo("renda")))
    return ROTULO_RENDA.get(c["faixa"], c["faixa"]) if c["faixa"] else NAO_INFORMADO


def faixa_cargo(d: dict) -> str:
    c = sc3_score_dados.classificar("cargo", cf(d, campo("cargo")))
    return c["faixa"].capitalize() if c["faixa"] else NAO_INFORMADO


def faixas_renda_ordem() -> list[str]:
    regras = config()["SC3_score_dados"]["renda"]["regras"]
    return [ROTULO_RENDA.get(r["faixa"], r["faixa"]) for r in reversed(regras)] + [NAO_INFORMADO]


def faixas_cargo_ordem() -> list[str]:
    c = config()["SC3_score_dados"]["cargo"]
    nomes = [r["faixa"].capitalize() for r in c["regras"]] + [c["sem_regra"]["faixa"].capitalize()]
    return list(dict.fromkeys(nomes)) + [NAO_INFORMADO]


def multiplicador(d: dict) -> float:
    return m2_faturamento_closer.multiplicador([d])


def nome_dono(d: dict) -> str:
    return m1_ganho_closer.nome_dono(d, usuarios()) or "—"


def pais(d: dict) -> str:
    """Só para a bandeirinha da venda (exibição). Não há regra de país na CRN."""
    return "CHILE" if "chile" in norm(cf(d, campo("produto"))) else "MEXICO"


def separar_ganhos(deals: list[dict], ano: int, mes: int) -> dict:
    return m1_ganho_closer.separar_ganhos(deals, ano, mes, usuarios())


def origem_temporal(d: dict, ano: int, mes: int) -> str:
    cri = data_brasil(d.get("add_time"))
    if no_mes(cri, ano, mes):
        return "cur"
    for k, n in (("prev", -1), ("prev2", -2)):
        a, m = add_meses(ano, mes, n)
        if no_mes(cri, a, m):
            return k
    return "antes"


def serializar_origem(ot: Counter, total: int, ano: int, mes: int) -> list[dict]:
    p1, p2 = add_meses(ano, mes, -1), add_meses(ano, mes, -2)
    r1, r2 = rotulo_mes(f"{p1[0]}-{p1[1]:02d}"), rotulo_mes(f"{p2[0]}-{p2[1]:02d}")
    pct = lambda v: round(v / total * 100) if total else 0
    return [
        {"label": f"Mês atual ({rotulo_mes(f'{ano}-{mes:02d}')})", "v": ot["cur"], "pct": pct(ot["cur"])},
        {"label": r1, "v": ot["prev"], "pct": pct(ot["prev"])},
        {"label": r2, "v": ot["prev2"], "pct": pct(ot["prev2"])},
        {"label": f"Antes de {r2}", "v": ot["antes"], "pct": pct(ot["antes"])},
    ]


def serializar_faixas(contagem: Counter, ordem: list[str], total: int) -> list[dict]:
    return [{"label": f, "v": contagem.get(f, 0), "pct": round(contagem.get(f, 0) / total * 100, 1) if total else 0}
            for f in ordem]


# ── metas (Colab + Metas do mês) ──────────────────────────────
def time_latam(ano: int, mes: int) -> tuple[list[dict], dict, list[str]]:
    """Pessoas LATAM na Colab do mês, metas financeiras por nome e avisos."""
    avisos = []
    try:
        colab = fontes.carregar_colab(ano, mes)
    except Exception as e:
        return [], {}, [f"Colab: {e}"]
    pessoas = [p for p in colab if "latam" in norm(p["squad"])]
    metas = {}
    try:
        for m in fontes.carregar_metas(ano, mes):
            metas[m["nome_norm"]] = m["meta_financeira"]
    except Exception as e:
        avisos.append(f"Metas: {e}")
    return pessoas, metas, avisos


def turmas() -> list[dict]:
    """Planilha de Turmas (fonte do painel, fora da CRN): produto, data de início, turma, real, mínimo, ideal."""
    if not os.environ.get("TURMAS_URL"):
        return []
    try:
        linhas = fontes.ler_csv("TURMAS_URL")
    except Exception as e:
        print("[turmas]", e)
        return []
    out = []
    for l in linhas:
        v = list(l.values())
        if len(v) < 6:
            continue
        prod = norm(v[0])
        produto = "Chile" if prod == "chile" else "Mexico" if prod == "mexico" else None
        if not produto:
            continue
        num = lambda x: int("".join(ch for ch in str(x) if ch.isdigit()) or 0)
        out.append({"produto": produto, "dataInicio": v[1], "turma": v[2],
                    "volumeReal": num(v[3]), "minimo": num(v[4]), "ideal": num(v[5])})
    return out


# ── /api/report ───────────────────────────────────────────────
def montar_report(ano: int, mes: int) -> dict:
    hoje = hoje_brasil()
    ini_mes = date(ano, mes, 1)
    fim_mes = date(ano, mes, calendar.monthrange(ano, mes)[1])
    semanas = ultimas_semanas(8)
    desde = min(ini_mes, semanas[0])
    deals = _cacheado(("deals", desde), 300, lambda: deals_latam_atualizados(desde))

    dias = [ini_mes + timedelta(days=i) for i in range(fim_mes.day)]
    semanas_set = set(semanas)
    ordem_renda, ordem_cargo = faixas_renda_ordem(), faixas_cargo_ordem()

    # ── Leads (data da última aplicação) ──
    C_total, C_dia, C_sem = 0, Counter(), Counter()
    C_status, C_renda, C_cargo, cargo_sem_regra = Counter(), Counter(), Counter(), Counter()
    ref = {"total": 0, "a": 0, "g": 0, "p": 0}
    st = {"open": "a", "won": "g", "lost": "p"}
    for d in deals:
        ap = data_aplicacao(d)
        if ap is None:
            continue
        if inicio_semana(ap) in semanas_set:
            C_sem[inicio_semana(ap)] += 1
        if not no_periodo(ap, ini_mes, fim_mes):
            continue
        C_total += 1
        C_dia[ap] += 1
        C_status[st.get(d.get("status"), "a")] += 1
        C_renda[faixa_renda(d)] += 1
        fc = faixa_cargo(d)
        C_cargo[fc] += 1
        if fc == config()["SC3_score_dados"]["cargo"]["sem_regra"]["faixa"].capitalize():
            cargo_sem_regra[str(cf(d, campo("cargo")) or "").strip() or "(vazio)"] += 1
    dias_passados = len([x for x in dias if x <= hoje]) or len(dias)
    # Referidos (RF1): pela data de criação, como a regra define. Indicação não passa pelo formulário,
    # então não tem "última aplicação" e não entra no total de leads acima.
    for lista in rf1_referidos.referidos_do_mes(deals, ano, mes).values():
        for d in lista:
            ref["total"] += 1
            ref[st.get(d.get("status"), "a")] += 1

    # ── Ganhos (M1: won_time Brasília, sem cortesia / outra moeda / automático) ──
    sep = separar_ganhos(deals, ano, mes)
    validos = sep["validos"]
    G_dia_t, G_dia_r, G_dia_m = Counter(), Counter(), Counter()
    G_ot = Counter()
    lista_ganhos = []
    for d in validos:
        dg = data_brasil(d.get("won_time"))
        bruto = numero(d.get("value"))
        mult = multiplicador(d)
        G_dia_t[dg] += 1
        G_dia_r[dg] += bruto
        G_dia_m[dg] += mult
        G_ot[origem_temporal(d, ano, mes)] += 1
        lista_ganhos.append({"id": d["id"], "titulo": d.get("title") or "—", "pais": pais(d),
                             "dataGanho": dg.isoformat(), "valor": bruto, "valorMult": mult,
                             "proprietario": nome_dono(d),
                             "addTime": data_brasil(d.get("add_time")).isoformat() if d.get("add_time") else None})
    G_sem_t, G_sem_r = Counter(), Counter()
    for s in semanas:
        a, b = s, s + timedelta(days=6)
        sep_s = m1_ganho_closer.separar_ganhos(deals, ini=a, fim=b, usuarios=usuarios())["validos"]
        G_sem_t[s] = len(sep_s)
        G_sem_r[s] = m2_faturamento_closer.bruto(sep_s)

    # ── Perdidos (M8: lost_time Brasília) ──
    perd = m8_deal_perdido.perdidos(deals, ini_mes, fim_mes, eixo="perda")
    P_dia, P_mot, P_renda, P_cargo, P_ot = Counter(), Counter(), Counter(), Counter(), Counter()
    lista_perd = []
    for d in perd:
        dl = data_brasil(d.get("lost_time"))
        mot = p1_motivo_perda.motivo(d)
        P_dia[dl] += 1
        P_mot[mot] += 1
        P_renda[faixa_renda(d)] += 1
        P_cargo[faixa_cargo(d)] += 1
        P_ot[origem_temporal(d, ano, mes)] += 1
        lista_perd.append({"id": d["id"], "addTime": data_brasil(d.get("add_time")).isoformat(),
                           "lostTime": dl.isoformat(), "proprietario": nome_dono(d), "pais": pais(d), "motivo": mot})
    P_sem = Counter()
    for s in semanas:
        P_sem[s] = len(m8_deal_perdido.perdidos(deals, s, s + timedelta(days=6), eixo="perda"))

    # ── Metas (M3 / T1, Colab e Metas do mês, dias úteis A2) ──
    pessoas, metas_nome, avisos = time_latam(ano, mes)
    try:
        feriados = fontes.carregar_feriados()
    except Exception as e:
        feriados, avisos = set(), avisos + [f"Feriados: {e}"]
    du = fontes.dias_uteis_periodo(ano, mes, feriados, hoje)
    por_dono = defaultdict(lambda: {"vendas": 0, "receita": 0.0, "receitaMult": 0.0})
    for d in validos:
        r = por_dono[norm(nome_dono(d))]
        r["vendas"] += 1
        r["receita"] += numero(d.get("value"))
        r["receitaMult"] += multiplicador(d)
    meta_total = sum(metas_nome.get(p["nome_norm"], 0) for p in pessoas)
    receita = m2_faturamento_closer.bruto(validos)
    receita_mult = m2_faturamento_closer.multiplicador(validos)
    mtd_time = t1_mtd_closer.mtd(receita, meta_total, du["total"], du["passados"])
    por_closer = []
    nomes_time = set()
    for p in pessoas:
        nomes_time.add(p["nome_norm"])
        meta = metas_nome.get(p["nome_norm"], 0)
        r = por_dono.get(p["nome_norm"], {"vendas": 0, "receita": 0.0, "receitaMult": 0.0})
        mtd_p = t1_mtd_closer.mtd(r["receita"], meta, du["total"], du["passados"])
        at = m3_atingimento_closer.atingimento(r["receita"], meta)
        at_m = m3_atingimento_closer.atingimento(r["receitaMult"], meta)
        por_closer.append({"nome": p["nome"], "meta": meta, "vendas": r["vendas"], "receita": r["receita"],
                           "receitaMult": r["receitaMult"],
                           "pctMeta": round(at, 1) if at is not None else 0,
                           "pctMetaMult": round(at_m, 1) if at_m is not None else 0,
                           "pctMTD": round(mtd_p["pct"], 1) if mtd_p["pct"] is not None else 0})
    # Venda no funil LATAM de quem não está no time LATAM da Colab: entra no total, aparece à parte
    for nn, r in por_dono.items():
        if nn not in nomes_time:
            nome = next((nome_dono(d) for d in validos if norm(nome_dono(d)) == nn), nn)
            por_closer.append({"nome": f"{nome} (fora do time)", "meta": 0, "vendas": r["vendas"],
                               "receita": r["receita"], "receitaMult": r["receitaMult"],
                               "pctMeta": 0, "pctMetaMult": 0, "pctMTD": 0})
    por_closer.sort(key=lambda c: -c["receita"])

    return {
        "ok": True, "mes": f"{ano}-{mes:02d}", "updatedAt": agora_brasil().isoformat(),
        "hoje": hoje.isoformat(),
        "carimbo": {"crn": crn.versao(), "recorte": "Funil LATAM (LT1)", "leads": "Data da última aplicação",
                    "valor": "Bruto (multiplicador à parte)", "squad": "Colab do mês",
                    "atualizado": agora_brasil().strftime("%d/%m/%Y %H:%M")},
        "avisos": avisos,
        "faixasLabels": ordem_renda,
        "turmas": _cacheado("turmas", 600, turmas),
        "cargoNaoMapeado": [{"raw": k, "count": v} for k, v in cargo_sem_regra.most_common()],
        "criados": {
            "total": C_total,
            "mediaDia": round(C_total / dias_passados, 1),
            "status": {"a": C_status["a"], "g": C_status["g"], "p": C_status["p"]},
            "scoreFaixas": serializar_faixas(C_renda, ordem_renda, C_total),
            "cargoFaixas": serializar_faixas(C_cargo, ordem_cargo, C_total),
            "referidos": ref,
            "porDia": [{"d": x.isoformat(), "v": C_dia[x]} for x in dias],
            "porSemana": [{"w": s.isoformat(), "v": C_sem[s]} for s in semanas],
        },
        "ganhos": {
            "porDia": [{"d": x.isoformat(), "v": G_dia_t[x], "r": G_dia_r[x], "rm": G_dia_m[x]} for x in dias],
            "porSemana": [{"w": s.isoformat(), "v": G_sem_t[s], "r": G_sem_r[s]} for s in semanas],
            "origemTemporal": serializar_origem(G_ot, len(validos), ano, mes),
            "deals": lista_ganhos,
            "foraDoTotal": {"cortesias": len(sep["cortesias"]), "outraMoeda": len(sep["outra_moeda"]),
                            "automaticos": len(sep["automaticos"])},
            "metas": {
                "total": meta_total, "mtd": mtd_time["meta_mtd"], "duMes": du["total"], "duMTD": du["passados"],
                "feriadosMes": sorted(f.isoformat() for f in feriados if f.year == ano and f.month == mes),
                "receitaAtual": receita, "receitaMult": receita_mult,
                "porCloser": por_closer,
            },
        },
        "perdidos": {
            "total": len(perd),
            "deals": lista_perd,
            "mediaDia": round(len(perd) / dias_passados, 1),
            "motivos": [{"m": m, "c": c, "pct": round(c / len(perd) * 100) if perd else 0}
                        for m, c in P_mot.most_common(10)],
            "scoreFaixas": serializar_faixas(P_renda, ordem_renda, len(perd)),
            "cargoFaixas": serializar_faixas(P_cargo, ordem_cargo, len(perd)),
            "porDia": [{"d": x.isoformat(), "v": P_dia[x]} for x in dias],
            "porSemana": [{"w": s.isoformat(), "v": P_sem[s]} for s in semanas],
            "origemTemporal": serializar_origem(P_ot, len(perd), ano, mes),
        },
    }


# ── /api/historico (últimos 12 meses) ─────────────────────────
def montar_historico() -> dict:
    hoje = hoje_brasil()
    a0, m0 = add_meses(hoje.year, hoje.month, -(MESES_HISTORICO - 1))
    meses = []
    a, m = a0, m0
    for _ in range(MESES_HISTORICO):
        meses.append((a, m))
        a, m = add_meses(a, m, 1)
    deals = _cacheado(("deals", date(a0, m0, 1)), 900, lambda: deals_latam_atualizados(date(a0, m0, 1)))
    chaves = [f"{a}-{m:02d}" for a, m in meses]

    criados = Counter()
    for d in deals:
        k = ym(data_aplicacao(d))
        if k in chaves:
            criados[k] += 1

    ganhos = {}
    perdidos = {}
    motivo_mes, motivo_renda, mes_renda = defaultdict(Counter), defaultdict(Counter), defaultdict(Counter)
    for (a, m), k in zip(meses, chaves):
        val = separar_ganhos(deals, a, m)["validos"]
        ganhos[k] = {"t": len(val), "r": m2_faturamento_closer.bruto(val),
                     "rm": m2_faturamento_closer.multiplicador(val),
                     "deals": [{"id": d["id"], "valor": numero(d.get("value")), "valorMult": multiplicador(d),
                                "proprietario": nome_dono(d), "pais": pais(d),
                                "dataGanho": data_brasil(d.get("won_time")).isoformat(),
                                "addTime": data_brasil(d.get("add_time")).isoformat(),
                                "titulo": d.get("title") or "—"} for d in val]}
        perd = m8_deal_perdido.perdidos(deals, date(a, m, 1), date(a, m, calendar.monthrange(a, m)[1]))
        mot = Counter(p1_motivo_perda.motivo(d) for d in perd)
        perdidos[k] = {"total": len(perd), "motivos": dict(mot)}
        for d in perd:
            mo = p1_motivo_perda.motivo(d)
            fr = faixa_renda(d)
            motivo_mes[mo][k] += 1
            motivo_renda[mo][fr] += 1
            cri = ym(data_brasil(d.get("add_time")))
            if cri:
                mes_renda[cri][fr] += 1

    total_motivo = Counter({mo: sum(v.values()) for mo, v in motivo_mes.items()})
    top10 = [mo for mo, _ in total_motivo.most_common(10)]
    meses_criacao = sorted(k for k in mes_renda if k >= chaves[0])
    return {
        "ok": True,
        "carimbo": {"crn": crn.versao(), "meses": MESES_HISTORICO},
        "historico": {"meses": chaves, "criados": {"total": dict(criados)}, "ganhos": ganhos, "perdidos": perdidos},
        "analises": {
            "top10Motivos": top10, "mesesDisp": chaves, "faixasDisp": faixas_renda_ordem(),
            "motivoMes": {mo: dict(motivo_mes[mo]) for mo in top10},
            "motivoRenda": {mo: dict(motivo_renda[mo]) for mo in top10},
            "mesRenda": {k: dict(mes_renda[k]) for k in meses_criacao},
            "mesesCriacao": meses_criacao,
        },
    }


# ── rotas ─────────────────────────────────────────────────────
def _mes_pedido() -> tuple[int, int]:
    q = (request.args.get("mes") or "").strip()
    if len(q) == 7 and q[4] == "-" and q[:4].isdigit() and q[5:].isdigit():
        return int(q[:4]), int(q[5:])
    h = hoje_brasil()
    return h.year, h.month


def _erro(e: Exception):
    traceback.print_exc()
    return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/report")
def api_report():
    try:
        ano, mes = _mes_pedido()
        return jsonify(montar_report(ano, mes))
    except Exception as e:
        return _erro(e)


@app.get("/api/historico")
def api_historico():
    try:
        return jsonify(_cacheado("historico", 900, montar_historico))
    except Exception as e:
        return _erro(e)


@app.post("/api/cache/clear")
def api_cache_clear():
    with _trava:
        _cache.clear()
    fontes._cache.clear()
    return jsonify({"ok": True, "msg": "Cache limpo. Próxima requisição buscará dados frescos."})


@app.get("/crn-versao")
@app.get("/api/crn-versao")
def crn_versao():
    return jsonify({"versao": crn.versao()})


@app.get("/")
def raiz():
    return send_from_directory(os.path.join(RAIZ, "public"), "index.html")


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 3000)), debug=False)
