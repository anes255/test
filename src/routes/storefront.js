import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { storeApi, aiApi } from '../../utils/api';
import { useCartStore, useLangStore } from '../../hooks/useStore';
import toast from 'react-hot-toast';
import { ShoppingCart, Heart, Search, User, X, Send, Bot, ChevronRight, Package, Menu } from 'lucide-react';

// ============ AI CHATBOT WIDGET ============
function AIChatbot({ store, slug }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [lang, setLang] = useState(null);
  const scrollRef = React.useRef(null);

  useEffect(() => {
    if (open && messages.length === 0)
      setMessages([{ role:'bot', text: store.ai_chatbot_greeting || `Welcome to ${store.name}! How can I help you today?` }]);
  }, [open]);

  // Auto-scroll on ANY change
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  // Detect language ONCE from first user message, then stick with it
  const getLang = (text) => {
    if (lang) return lang;
    const hasArabic = /[\u0600-\u06FF]/.test(text);
    const hasFrench = /[àâéèêëïîôùûüÿçœæ]|(?:^|\s)(je|tu|il|nous|vous|les|des|une|est|bonjour|merci|comment|combien)(?:\s|$)/i.test(text);
    const detected = hasArabic ? 'ar' : hasFrench ? 'fr' : 'en';
    setLang(detected);
    return detected;
  };

  const sendMessage = async (text) => {
    if (!text.trim()) return;
    // Check if user wants to switch language
    const lower = text.toLowerCase();
    if (lower.includes('speak english') || lower.includes('switch to english')) setLang('en');
    else if (lower.includes('parle français') || lower.includes('switch to french') || lower.includes('en français')) setLang('fr');
    else if (lower.includes('بالعربية') || lower.includes('switch to arabic') || lower.includes('تكلم عربي')) setLang('ar');

    const msgLang = lang || getLang(text);
    setMessages(prev=>[...prev,{role:'user',text}]);
    setInput('');
    setLoading(true);
    try {
      const{data}=await aiApi.chat(slug,{message:text,history:messages,language:msgLang});
      setMessages(prev=>[...prev,{role:'bot',text:data.response}]);
    } catch(e) { setMessages(prev=>[...prev,{role:'bot',text:e.response?.data?.error || "Sorry, I'm having trouble. Please try again!"}]); }
    setLoading(false);
  };

  return (
    <>
      <button onClick={()=>setOpen(!open)} className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-2xl text-white shadow-2xl flex items-center justify-center hover:scale-105 transition-transform" style={{background:'linear-gradient(135deg, #7C3AED, #9333EA)'}}>
        {open ? <X size={22}/> : <Bot size={22}/>}
      </button>
      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[360px] max-h-[500px] bg-white rounded-3xl shadow-2xl border border-gray-100 flex flex-col overflow-hidden animate-slide-up">
          <div className="p-4" style={{background:'linear-gradient(135deg, #7C3AED, #9333EA)'}}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center"><Bot size={20} className="text-white"/></div>
              <div className="flex-1"><h3 className="font-bold text-sm text-white">{store.ai_chatbot_name || 'Kyo-Bot Support Unit'}</h3><p className="text-white/70 text-xs flex items-center gap-1"><span className="w-2 h-2 bg-emerald-400 rounded-full"/>Operational</p></div>
              <button onClick={()=>setOpen(false)} className="text-white/60 hover:text-white"><X size={18}/></button>
            </div>
          </div>
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[280px]">
            {messages.map((msg,i)=>(
              <div key={i} className={`flex ${msg.role==='user'?'justify-end':'justify-start'}`}>
                {msg.role==='bot'&&<div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center mr-2 shrink-0 mt-1"><Bot size={14} className="text-gray-500"/></div>}
                <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm ${msg.role==='user'?'bg-brand-500 text-white rounded-tr-sm':'bg-gray-100 text-gray-800 rounded-tl-sm'}`}>{msg.text}</div>
              </div>
            ))}
            {loading&&(<div className="flex justify-start"><div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center mr-2 shrink-0"><Bot size={14} className="text-gray-500"/></div><div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3"><div className="flex gap-1"><div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"/><div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{animationDelay:'0.15s'}}/><div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{animationDelay:'0.3s'}}/></div></div></div>)}
          </div>
          <div className="px-4 pb-2">
            <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider mb-1.5">SUGGESTED ACTIONS</p>
            <div className="flex flex-wrap gap-1.5">
              {['Shipping rates','Best sellers','Contact info'].map((s,i)=>(
                <button key={i} onClick={()=>sendMessage(s)} className="px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-full text-xs font-medium text-gray-600 hover:bg-brand-50 hover:text-brand-600 hover:border-brand-200 transition-all">{s} <ChevronRight size={10} className="inline"/></button>
              ))}
            </div>
          </div>
          <div className="p-3 border-t border-gray-100">
            <div className="flex gap-2">
              <input className="flex-1 px-3 py-2.5 bg-gray-50 rounded-xl text-sm border border-gray-200 focus:outline-none focus:border-brand-400" placeholder="Enter command..." value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&sendMessage(input)}/>
              <button onClick={()=>sendMessage(input)} className="w-10 h-10 rounded-xl flex items-center justify-center text-white transition-colors" style={{backgroundColor:store.primary_color||'#7C3AED'}}><Send size={14}/></button>
            </div>
            <p className="text-[9px] text-gray-300 text-center mt-1.5">Powered by {store.name} KyoBot V2</p>
          </div>
        </div>
      )}
    </>
  );
}

// ============ LANGUAGE SWITCHER (inline for store header) ============
function StoreLangSwitcher() {
  const { i18n } = useTranslation();
  const { lang, setLang } = useLangStore();
  const langs = [{code:'en',label:'EN',flag:'🟢'},{code:'fr',label:'FR',flag:'🇫🇷'},{code:'ar',label:'AR',flag:'🇩🇿'}];
  return (
    <div className="flex items-center gap-0.5 bg-gray-100 rounded-full p-0.5">
      {langs.map(l=>(
        <button key={l.code} onClick={()=>{i18n.changeLanguage(l.code);setLang(l.code);}} className={`px-2.5 py-1 rounded-full text-xs font-bold transition-all ${lang===l.code?'bg-brand-500 text-white shadow':'text-gray-500'}`}>
          {l.flag} {l.label}
        </button>
      ))}
    </div>
  );
}

// ============ MAIN STOREFRONT ============
export default function Storefront() {
  const { storeSlug } = useParams();
  const { t } = useTranslation();
  const { lang } = useLangStore();
  const { addItem, getCount } = useCartStore();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [wishlist, setWishlist] = useState(()=>{try{return JSON.parse(localStorage.getItem('wishlist_'+storeSlug)||'[]').map(x=>x.id||x);}catch{return[];}});

  const [suspended, setSuspended] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [storeRes, productsRes, catsRes] = await Promise.all([
          storeApi.getStore(storeSlug),
          storeApi.getProducts(storeSlug, { search, category: selectedCategory }),
          storeApi.getCategories(storeSlug),
        ]);
        setStore(storeRes.data);
        setProducts(productsRes.data.products);
        setCategories(catsRes.data);
      } catch(e) { if(e.response?.status===403&&e.response?.data?.suspended)setSuspended(true);else setStore(null); }
      setLoading(false);
    };
    load();
  }, [storeSlug, search, selectedCategory]);

  const getName = (item) => {
    if (lang==='ar') return item.name_ar||item.name_en||item.name||'';
    if (lang==='fr') return item.name_fr||item.name_en||item.name||'';
    return item.name_en||item.name||'';
  };

  const toggleWishlist = (id) => {
    const inList = wishlist.includes(id);
    const newList = inList ? wishlist.filter(x=>x!==id) : [...wishlist, id];
    setWishlist(newList);
    // Save full product objects for the Favorites page
    const saved = products.filter(p=>newList.includes(p.id));
    localStorage.setItem('wishlist_'+storeSlug, JSON.stringify(saved));
  };

  const getThumb = (p) => {
    if (p.thumbnail) return p.thumbnail;
    if (Array.isArray(p.images)&&p.images.length) return typeof p.images[0]==='string'?p.images[0]:null;
    return null;
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="w-10 h-10 rounded-full border-4 border-gray-200 border-t-brand-500 animate-spin"/></div>;
  if (suspended) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-center max-w-md"><div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4"><Package size={32} className="text-red-500"/></div><h1 className="text-2xl font-bold text-gray-900 mb-2">Store Temporarily Unavailable</h1><p className="text-gray-500">This store is currently suspended. Please check back later or contact the store owner.</p></div></div>;
  if (!store) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="text-center"><Package size={48} className="mx-auto text-gray-300 mb-4"/><p className="text-gray-500 text-lg font-medium">Store not found</p><Link to="/" className="text-brand-500 text-sm font-semibold hover:underline mt-2 inline-block">Go to homepage</Link></div></div>;

  const pc = store.primary_color || '#7C3AED';

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      {/* ============ HEADER ============ */}
      <header className="bg-white sticky top-0 z-30 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to={`/s/${storeSlug}`} className="flex items-center gap-2.5">
            {store.logo ? <img src={store.logo} className="w-9 h-9 rounded-lg object-cover" alt=""/> : <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold" style={{backgroundColor:pc}}>{store.name?.[0]}</div>}
            <span className="text-lg font-extrabold text-gray-900">{store.name}</span>
            <span className="text-gray-300">📢</span>
          </Link>
          <div className="flex items-center gap-3">
            <StoreLangSwitcher />
            <Link to={`/s/${storeSlug}/auth`} className="p-2 hover:bg-gray-100 rounded-full text-gray-500"><User size={20}/></Link>
            <Link to={`/s/${storeSlug}/favorites`} className="p-2 hover:bg-gray-100 rounded-full text-gray-500 relative">
              <Heart size={20}/>
              {wishlist.length>0&&<span className="absolute -top-0.5 -right-0.5 w-4.5 h-4.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center min-w-[18px]">{wishlist.length}</span>}
            </Link>
            <Link to={`/s/${storeSlug}/checkout`} className="p-2 hover:bg-gray-100 rounded-full text-gray-500 relative">
              <ShoppingCart size={20}/>
              {getCount()>0&&<span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">{getCount()}</span>}
            </Link>
          </div>
        </div>
      </header>

      {/* ============ HERO ============ */}
      <section className="relative py-16 px-4 text-center overflow-hidden" style={{background:store.cover_image?'none':'#f0f0f0'}}>
        {store.cover_image&&<div className="absolute inset-0"><img src={store.cover_image} className="w-full h-full object-cover" alt=""/><div className="absolute inset-0 bg-black/40"/></div>}
        <div className="relative z-10">
          <h1 className={`text-5xl md:text-6xl font-black italic tracking-tight ${store.cover_image?'text-white':'text-gray-900'}`} style={{fontFamily:'"Georgia","Times New Roman",serif'}}>{store.hero_title || store.name}</h1>
          <p className={`mt-3 max-w-xl mx-auto text-sm leading-relaxed ${store.cover_image?'text-white/80':'text-gray-500'}`}>
            {store.hero_subtitle || store.description || 'See why this product stands out from the rest. Every detail is meticulously designed for your satisfaction.'}
          </p>
          <div className="w-12 h-1 mx-auto mt-4 rounded-full" style={{backgroundColor:store.cover_image?'#fff':pc}}/>
        </div>
      </section>

      {/* ============ SEARCH BAR ============ */}
      <div className="max-w-4xl mx-auto px-4 -mt-5 relative z-10">
        <div className="flex items-center bg-white rounded-xl shadow-lg overflow-hidden">
          <div className="flex-1 relative">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input className="w-full pl-11 pr-4 py-3.5 text-sm focus:outline-none" placeholder={t('store.search')} value={search} onChange={e=>setSearch(e.target.value)}/>
          </div>
          <button className="px-5 py-3.5 text-xs font-extrabold uppercase tracking-wider text-gray-700 border-l border-gray-100 hover:bg-gray-50 transition-colors">{t('store.allCategories')}</button>
          <button className="px-5 py-3.5 text-xs font-extrabold uppercase tracking-wider text-white" style={{backgroundColor:pc}}>{t('store.new')}</button>
        </div>
      </div>

      {/* ============ CATEGORY TABS ============ */}
      <div className="max-w-7xl mx-auto px-4 mt-6">
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          <button onClick={()=>setSelectedCategory(null)} className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${!selectedCategory?'text-white shadow-md':'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'}`} style={!selectedCategory?{backgroundColor:pc}:{}}>All</button>
          {categories.map(cat=>(
            <button key={cat.id} onClick={()=>setSelectedCategory(cat.id)} className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${selectedCategory===cat.id?'text-white shadow-md':'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200'}`} style={selectedCategory===cat.id?{backgroundColor:pc}:{}}>{getName(cat)}</button>
          ))}
        </div>
      </div>

      {/* ============ PRODUCTS GRID ============ */}
      <div className="max-w-7xl mx-auto px-4 py-8">
        {products.length===0?(
          <div className="text-center py-20"><Package size={48} className="mx-auto text-gray-300 mb-4"/><p className="text-gray-500">No products found</p></div>
        ):(
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-5">
            {products.map(product=>{
              const thumb = getThumb(product);
              const inWishlist = wishlist.includes(product.id);
              return (
                <div key={product.id} className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all group relative">
                  {/* Product Image */}
                  <Link to={`/s/${storeSlug}/product/${product.slug}`} className="block">
                    <div className="aspect-square bg-gray-100 relative overflow-hidden">
                      {thumb?<img src={thumb} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" alt=""/>
                        :<div className="w-full h-full flex items-center justify-center"><Package size={32} className="text-gray-300"/></div>}
                      {product.compare_at_price&&<span className="absolute top-2 left-2 px-2 py-1 bg-red-500 text-white text-[10px] font-bold rounded-lg">SALE</span>}
                    </div>
                  </Link>

                  {/* Action buttons — floating */}
                  <div className="absolute top-3 right-3 flex flex-col gap-1.5">
                    <button onClick={()=>{addItem(product);toast.success('Added!');}} className="w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-lg hover:scale-110 transition-transform" style={{backgroundColor:pc}}><ShoppingCart size={14}/></button>
                    <button onClick={()=>toggleWishlist(product.id)} className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-lg hover:scale-110 transition-transform ${inWishlist?'bg-red-500 text-white':'bg-white text-gray-400 hover:text-red-500'}`}><Heart size={14} fill={inWishlist?'white':'none'}/></button>
                  </div>

                  {/* Product Info */}
                  <div className="p-3.5">
                    <Link to={`/s/${storeSlug}/product/${product.slug}`}>
                      <h3 className="font-semibold text-sm text-gray-800 truncate hover:text-brand-600 transition-colors">{getName(product)}</h3>
                    </Link>
                    <div className="flex items-baseline gap-2 mt-2">
                      <span className="text-lg font-extrabold" style={{color:pc}}>{parseFloat(product.price).toLocaleString()}</span>
                      <span className="text-xs text-gray-400">{store.currency||'DZD'}</span>
                      {product.compare_at_price&&<span className="text-xs text-gray-400 line-through">{parseFloat(product.compare_at_price).toLocaleString()}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ============ FOOTER ============ */}
      <footer className="bg-white border-t border-gray-100 py-8 px-4 mt-8">
        <div className="max-w-7xl mx-auto text-center">
          <p className="text-sm text-gray-400">{store.footer_text || `© ${new Date().getFullYear()} ${store.name}. All rights reserved.`}</p>
          <p className="text-xs text-gray-300 mt-1">Powered by KyoMarket</p>
        </div>
      </footer>

      {/* ============ AI CHATBOT ============ */}
      <AIChatbot store={store} slug={storeSlug}/>

      {/* ============ MOBILE BOTTOM NAV ============ */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 z-30 px-4 py-2 flex items-center justify-around safe-area-bottom">
        <Link to={`/s/${storeSlug}`} className="flex flex-col items-center gap-0.5 text-gray-400"><Package size={20}/><span className="text-[10px]">Shop</span></Link>
        <Link to={`/s/${storeSlug}/auth`} className="flex flex-col items-center gap-0.5 text-gray-400"><User size={20}/><span className="text-[10px]">Account</span></Link>
        <Link to={`/s/${storeSlug}/checkout`} className="flex flex-col items-center gap-0.5 relative" style={{color:pc}}>
          <ShoppingCart size={20}/>
          {getCount()>0&&<span className="absolute -top-1 right-0 w-4 h-4 bg-red-500 text-white text-[8px] rounded-full flex items-center justify-center">{getCount()}</span>}
          <span className="text-[10px]">Cart</span>
        </Link>
      </div>
    </div>
  );
}
