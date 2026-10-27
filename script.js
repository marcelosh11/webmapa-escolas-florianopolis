// O arquivo escolas.csv NÃO contém latitude nem longitude.
// O serviço Nominatim transforma cada endereço em uma posição apenas durante a execução.
const mapa = L.map('map').setView([-27.595, -48.55], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(mapa);
const marcadores = L.featureGroup().addTo(mapa);
const statusEl = document.getElementById('status');
const listaEl = document.getElementById('lista');
const buscaEl = document.getElementById('busca');
const iniciarEl = document.getElementById('iniciar');
const EMAIL_GEOCODIFICACAO = 'seu_email@exemplo.com';
let escolas = [], emExecucao = false;
const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
const chave = e => 'geo_escola_v1_' + e.codigo_inep;
function textoSeguro(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function fetchComTimeout(url, options = {}, timeoutMs = 20000){
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  try{
    return await fetch(url, { ...options, signal: controlador.signal, headers: { Accept: 'application/json', 'Accept-Language': 'pt-BR', ...(options.headers || {}) } });
  } finally {
    clearTimeout(temporizador);
  }
}
function lerCSV(texto){
  // CSV padrão: campos entre aspas podem conter vírgulas e quebras de linha.
  const linhas=[];let linha=[],campo='',aspas=false;
  for(let i=0;i<texto.length;i++){
    const c=texto[i];if(c==='"'){if(aspas&&texto[i+1]==='"'){campo+='"';i++;}else aspas=!aspas;}
    else if(c===','&&!aspas){linha.push(campo);campo='';}
    else if((c==='\n'||c==='\r')&&!aspas){if(c==='\r'&&texto[i+1]==='\n')i++;linha.push(campo);if(linha.some(v=>v.trim()))linhas.push(linha);linha=[];campo='';}
    else campo+=c;
  }
  if(campo||linha.length){linha.push(campo);linhas.push(linha);}
  const cab=linhas.shift().map(v=>v.replace(/^\uFEFF/,'').trim());
  return linhas.map(vals=>Object.fromEntries(cab.map((c,i)=>[c,vals[i]??''])));
}
function enderecoConsulta(e){
  // Conserva o endereço da planilha e acrescenta contexto para evitar cidades homônimas.
  return e.endereco.includes('Florianópolis') ? e.endereco : `${e.endereco}, Florianópolis, Santa Catarina, Brasil`;
}
async function geocodificar(e){
  if (location.protocol === 'file:') {
    throw new Error('Abra o projeto com um servidor local (Live Server) antes de executar a geocodificação.');
  }
  const params = new URLSearchParams({
    q: enderecoConsulta(e),
    format: 'jsonv2',
    limit: '5',
    countrycodes: 'br',
    addressdetails: '1',
    email: EMAIL_GEOCODIFICACAO,
    dedupe: '1',
    'accept-language': 'pt-BR'
  });
  const resposta = await fetchComTimeout('https://nominatim.openstreetmap.org/search?' + params.toString(), { headers: { Referer: window.location.origin || 'http://localhost' } });
  if (!resposta.ok) {
    const texto = await resposta.text().catch(() => '');
    if (resposta.status === 429 || resposta.status === 403) {
      throw new Error('Serviço de geocodificação temporariamente bloqueado pelo Nominatim (limite de consultas). Aguarde alguns minutos e tente novamente.');
    }
    throw new Error('Serviço indisponível (HTTP ' + resposta.status + '). Tente novamente mais tarde.');
  }
  const resultados = await resposta.json();
  const locais = resultados.filter(r => {
    const a = r.address || {};
    const texto = [a.city, a.town, a.municipality, a.county, r.display_name].filter(Boolean).join(' ').toLowerCase();
    return texto.includes('florianópolis') || texto.includes('florianopolis');
  });
  if (!locais.length) return null;
  // Se houver vários candidatos, não escolher silenciosamente uma posição possivelmente incorreta.
  if (locais.length > 1) return { pendente: true, opcoes: locais.map(r => r.display_name) };
  return { lat: Number(locais[0].lat), lng: Number(locais[0].lon), descricao: locais[0].display_name };
}
function renderizar(){
  marcadores.clearLayers();listaEl.replaceChildren();let encontrados=0;
  const termo=buscaEl.value.toLocaleLowerCase('pt-BR');
  for(const e of escolas){
    const geo=e.geo;if(geo?.lat!==undefined)encontrados++;
    if(!e.nome.toLocaleLowerCase('pt-BR').includes(termo))continue;
    const li=document.createElement('li');const b=document.createElement('button');b.textContent=e.nome;
    const sub=document.createElement('small');sub.textContent=geo?.lat!==undefined?'Localizada':geo?.pendente?'Localização ambígua — revisar':geo?.erro?'Falha na consulta — tentar novamente':geo?.naoEncontrado?'Endereço não encontrado':'Ainda não localizada';li.append(b,sub);listaEl.append(li);
    if(geo?.lat!==undefined){const m=L.marker([geo.lat,geo.lng]).bindPopup(`<strong>${textoSeguro(e.nome)}</strong><p>${textoSeguro(e.endereco)}</p><p>INEP: ${textoSeguro(e.codigo_inep)}<br>${textoSeguro(e.etapas)}<br>${textoSeguro(e.telefone)}</p><small>Posição obtida por geocodificação; conferir precisão.</small>`);m.addTo(marcadores);b.onclick=()=>{mapa.setView(m.getLatLng(),16);m.openPopup();};}
    else b.disabled=true;
  }
  if(!emExecucao)statusEl.textContent=`${encontrados} de ${escolas.length} escolas localizadas`;
}
async function iniciar(){
 if(emExecucao)return;
 emExecucao=true;iniciarEl.disabled=true;
 let ultima=0, falhas=0, semResultado=0, processadas=0;
 try{
  for(let i=0;i<escolas.length;i++){
   const e=escolas[i];if(e.geo?.lat!==undefined)continue;
   statusEl.textContent=`Consultando ${i+1}/${escolas.length}: ${e.nome} — falhas: ${falhas}`;
   const espera=Math.max(0,1300-(Date.now()-ultima));if(espera)await pausa(espera);
   ultima=Date.now();
   try{
    const geo=await geocodificar(e);
    e.geo=geo||{naoEncontrado:true};
    if(!geo)semResultado++;
    if(geo?.lat!==undefined)localStorage.setItem(chave(e),JSON.stringify(geo));
   }catch(err){
    falhas++;
    e.geo={erro:String(err.message||err)};
    // Erros 429/403: interromper para respeitar os limites do serviço.
    if(/HTTP (429|403)|bloqueado pelo Nominatim|Servidor local/.test(e.geo.erro)){
      statusEl.textContent=`${e.geo.erro}`;
      return;
    }
   }
   processadas++;
   renderizar();
   statusEl.textContent=`Processadas: ${processadas} | Falhas: ${falhas} | Sem resultado: ${semResultado} | Escola: ${e.nome}`;
  }
  statusEl.textContent=`Concluído: ${escolas.filter(e=>e.geo?.lat!==undefined).length}/${escolas.length} localizadas. ${falhas} falhas de consulta; ${semResultado} sem resultado.`;
  if(marcadores.getLayers().length)mapa.fitBounds(marcadores.getBounds().pad(.12));
 }finally{emExecucao=false;iniciarEl.disabled=false;setTimeout(()=>mapa.invalidateSize(),100);}
}
buscaEl.addEventListener('input',renderizar);
iniciarEl.addEventListener('click',iniciar);
document.getElementById('limpar').addEventListener('click',()=>{if(emExecucao)return;for(const e of escolas){localStorage.removeItem(chave(e));e.geo=null;}renderizar();});
(async()=>{try{if (location.protocol === 'file:') throw new Error('Abra o projeto por um servidor local (Live Server) para carregar os dados e geocodificar.');
const r=await fetch('escolas.csv');if(!r.ok)throw Error('Não foi possível abrir escolas.csv');escolas=lerCSV(await r.text());for(const e of escolas){try{e.geo=JSON.parse(localStorage.getItem(chave(e))||'null');}catch{e.geo=null;}}renderizar();}catch(err){statusEl.textContent=err.message+' — abra o projeto por um servidor local (Live Server).';}})();
window.addEventListener('load',()=>setTimeout(()=>mapa.invalidateSize(),400));
