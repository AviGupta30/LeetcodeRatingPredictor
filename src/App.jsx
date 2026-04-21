import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Search, Bell, X, Trophy, Target, Clock, Info,
  Wifi, WifiOff, RefreshCw, ChevronDown, Loader2, Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs) { return twMerge(clsx(inputs)); }

// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = 'https://leetcoderatingpredictor.onrender.com';
const TOP_RANK_N = 3;
const POLL_MS = 2500;   // progress poll interval (ms)

// ─── Utility: format Unix epoch or duration → HH:MM:SS ───────────────────────
function fmtTime(ts) {
  if (!ts) return '--:--:--';
  if (ts < 86400) {
    const h = String(Math.floor(ts / 3600)).padStart(2, '0');
    const m = String(Math.floor((ts % 3600) / 60)).padStart(2, '0');
    const s = String(ts % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour12: false });
}

// ────────────────────────────────────────────────────────────────────────────────
// Hook: useContests — fetch dynamic contest list from Supabase
// ────────────────────────────────────────────────────────────────────────────────
function useContests() {
  const [contests, setContests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/contests/latest`)
      .then(r => r.json())
      .then(data => {
        setContests(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        setContests([]);
        setLoading(false);
      });
  }, []);

  return { contests, loading };
}

// ────────────────────────────────────────────────────────────────────────────────
// Hook: usePredictions — fetch + poll progress + handle 202 "scraping" state
// ────────────────────────────────────────────────────────────────────────────────
function usePredictions(contestSlug) {
  const [data, setData] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ pct: 0, pages_done: 0, total_pages: 0 });
  const [meta, setMeta] = useState({ total: 0, contest: '' });
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollProgress = useCallback((slug) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/predict/${slug}/progress`);
        const prog = await r.json();
        setProgress({ pct: prog.pct, pages_done: prog.pages_done, total_pages: prog.total_pages });

        if (prog.status === 'done') {
          stopPolling();
          fetchPredictions(slug, false);
        } else if (prog.status === 'error') {
          stopPolling();
          setStatus('error');
          setError('Scrape failed on the server. Check backend logs.');
        }
      } catch {/* ignore poll errors */ }
    }, POLL_MS);
  }, []);

  const fetchPredictions = useCallback(async (slug, triggerRefresh = false) => {
    if (!slug) return;
    setStatus('loading');
    setError(null);
    setData([]);
    setProgress({ pct: 0, pages_done: 0, total_pages: 0 });

    try {
      const url = triggerRefresh
        ? `${API_BASE}/predict/${slug}?refresh=true`
        : `${API_BASE}/predict/${slug}`;

      const res = await fetch(url);

      if (res.status === 202) {
        setStatus('scraping');
        pollProgress(slug);
        return;
      }

      if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);

      const json = await res.json();
      setData(json.predictions || []);
      setMeta({ total: json.total_participants, contest: json.contest_slug });
      setStatus('done');

    } catch (err) {
      if (err.message.includes('202') || err.message.includes('404') || err.message.includes('Failed to fetch')) {
        setStatus('scraping');
        try {
          const r2 = await fetch(`${API_BASE}/predict/${slug}`);
          if (r2.status === 202 || r2.ok) {
            setStatus('scraping');
            pollProgress(slug);
            return;
          }
        } catch { /* fallthrough */ }
      }
      setStatus('error');
      setError(err.message);
    }
  }, [pollProgress]);

  useEffect(() => {
    if (!contestSlug) return;
    stopPolling();
    fetchPredictions(contestSlug, false);
    return () => stopPolling();
  }, [contestSlug]);

  return {
    data, status, error, progress, meta,
    refetch: () => fetchPredictions(contestSlug, true),
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Root App
// ────────────────────────────────────────────────────────────────────────────────
const App = () => {
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedContest, setSelectedContest] = useState(null);

  const { contests, loading: contestsLoading } = useContests();
  const { data, status, error, progress, meta, refetch } = usePredictions(
    selectedContest?.slug
  );

  useEffect(() => {
    if (!selectedContest && contests.length > 0) {
      setSelectedContest(contests[0]);
    }
  }, [contests, selectedContest]);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase().trim();
    return data.filter(u =>
      u.username.toLowerCase().includes(q) ||
      String(u.global_rank).includes(q)
    );
  }, [data, search]);

  const handleContestSelect = (c) => { setSelectedContest(c); setDropdownOpen(false); setSearch(''); };

  const isLive = status === 'done';
  const isScraping = status === 'scraping' || status === 'fetching_ratings';
  const isLoading = status === 'loading' || (status === 'idle' && !!selectedContest);

  return (
    <div className="min-h-screen text-slate-100 flex flex-col bg-cover bg-fixed bg-center bg-no-repeat overflow-x-hidden"
      style={{ backgroundImage: "url('/bg_map.png')", backgroundColor: '#050a11', fontFamily: "'Inter', -apple-system, sans-serif" }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 bg-[#121821] border-b border-[#1E293B]/70 shadow-xl h-14">
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 h-full flex items-center justify-between">

          {/* Left Area: Logo, Shield, Dropdown */}
          <div className="flex items-center">
            {/* Logo */}
            <div className="flex items-center gap-2.5 shrink-0 hover:opacity-90 cursor-pointer">
              <div className="w-7 h-7 rounded-[6px] flex items-center justify-center bg-gradient-to-br from-[#F97316] to-[#EA580C] shadow-[0_0_12px_rgba(249,115,22,0.25)]">
                <Trophy className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="hidden sm:block text-[13px] font-bold text-slate-400 tracking-wide">
                Contest Predictor
              </span>
            </div>

            {/* Overlapping Shield Badge - Hidden on mobile to save space */}
            <div className="relative mx-5 hidden md:block">
              <div className="absolute top-[-26px] left-0 w-[42px] h-[52px] bg-gradient-to-b from-[#374151] to-[#1F2937] flex justify-center items-center z-50 shadow-[0_4px_10px_rgba(0,0,0,0.5)]"
                style={{ clipPath: 'polygon(50% 100%, 100% 75%, 100% 0, 0 0, 0 75%)' }}>
                <div className="w-[38px] h-[48px] bg-gradient-to-b from-[#2B3544] to-[#1C2532] flex flex-col justify-center items-center pb-1"
                  style={{ clipPath: 'polygon(50% 100%, 100% 75%, 100% 0, 0 0, 0 75%)', marginTop: '-2px' }}>
                  <Trophy className="w-[18px] h-[18px] text-[#F97316]" style={{ filter: 'drop-shadow(0 2px 4px rgba(249,115,22,0.4))' }} />
                  <div className="text-white text-[8px] opacity-70 mt-0.5">★</div>
                </div>
              </div>
              <div className="w-[42px]"></div>
            </div>

            {/* Contest Dropdown */}
            <div className="relative shrink-0 ml-3 sm:ml-[10px] w-36 sm:w-48">
              <button onClick={() => setDropdownOpen(v => !v)}
                className="w-full h-[30px] flex items-center justify-between px-2 sm:px-3 rounded text-[10px] sm:text-[11px] font-semibold bg-[#222A38] border border-[#2F3A4C] text-slate-300 hover:bg-[#2A3445] transition-all">
                <div className="flex items-center gap-1.5 overflow-hidden">
                  <Zap className="w-3 h-3 text-[#F97316] shrink-0" />
                  <span className="truncate">{contestsLoading ? 'Loading...' : selectedContest?.title ?? 'Select Contest'}</span>
                </div>
                <ChevronDown className={cn("w-3 h-3 text-slate-500 transition-transform shrink-0", dropdownOpen && "rotate-180")} />
              </button>
              <AnimatePresence>
                {dropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}
                    className="absolute top-full mt-2 left-0 right-0 z-50 rounded bg-[#111827] border border-[#1F2937] shadow-2xl overflow-hidden">
                    {contestsLoading
                      ? <div className="px-4 py-3 text-xs text-slate-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Loading...</div>
                      : contests.length === 0
                        ? <div className="px-4 py-3 text-xs text-slate-500">No contests found</div>
                        : contests.map(c => (
                          <button key={c.slug} onClick={() => handleContestSelect(c)}
                            className={cn("w-full text-left px-3 py-2 text-[11px] hover:bg-[#1F2937]", selectedContest?.slug === c.slug ? "text-[#F97316]" : "text-slate-300")}>
                            {c.title}
                          </button>
                        ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Right Area: Search, Refresh, Live, Avatar */}
          <div className="flex items-center gap-3 sm:gap-5 flex-1 justify-end">

            {/* Styled Search Bar - Desktop Only */}
            <div className="relative w-[340px] group hidden lg:block">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 group-focus-within:text-[#37B5AC] transition-colors" />
              <input type="text" placeholder="Search username or rank..."
                value={search} onChange={e => setSearch(e.target.value)}
                className="w-full h-8 pl-9 pr-4 rounded text-[11px] text-slate-200 placeholder-slate-600
                                bg-[#1A222D] border border-transparent outline-none shadow-inner
                                focus:bg-[#1E2835] transition-all" />
              <div className="absolute -bottom-[0px] left-10 right-10 h-[1.5px] bg-gradient-to-r from-transparent via-[#37B5AC] to-transparent opacity-80" />
            </div>

            {/* Account Config & Specs */}
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <button onClick={refetch} disabled={isScraping || isLoading} className="group">
                <RefreshCw className={cn("w-4 h-4 text-slate-500 group-hover:text-white transition", (isScraping || isLoading) && "animate-spin")} />
              </button>

              <div className="flex items-center gap-1 text-[8px] sm:text-[9px] font-bold tracking-wider px-2 py-0.5 rounded-full"
                style={{
                  background: isLive ? 'rgba(55,181,172,0.1)' : isScraping ? 'rgba(251,191,36,0.1)' : 'rgba(217,69,91,0.1)',
                  borderColor: isLive ? 'rgba(55,181,172,0.3)' : isScraping ? 'rgba(251,191,36,0.3)' : 'rgba(217,69,91,0.3)',
                  borderWidth: 1,
                  color: isLive ? '#37B5AC' : isScraping ? '#FBBF24' : '#D9455B',
                }}>
                {isLive ? <Wifi className="w-2 h-2 sm:w-2.5 sm:h-2.5" /> : isScraping ? <Loader2 className="w-2 h-2 sm:w-2.5 sm:h-2.5 animate-spin" /> : <WifiOff className="w-2 h-2 sm:w-2.5 sm:h-2.5" />}
                <span className="hidden sm:inline">{isLive ? '1 TVF' : status === 'fetching_ratings' ? 'FETCH' : isScraping ? 'SCRAPE' : 'OFF'}</span>
              </div>

              <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-slate-800 overflow-hidden cursor-pointer opacity-90 hover:opacity-100 transition-opacity">
                <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=Admin`} alt="avatar" />
              </div>
            </div>

          </div>
        </div>
      </header>

      {/* ── Main ────────────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-2 sm:px-6 py-4 sm:py-8 relative">

        {/* Mobile Search Bar - Visible only on small screens */}
        <div className="relative w-full mb-4 lg:hidden group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 group-focus-within:text-[#37B5AC] transition-colors" />
          <input type="text" placeholder="Search username or rank..."
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full h-10 pl-10 pr-4 rounded-lg text-sm text-slate-200 placeholder-slate-500
                       bg-[#121821]/80 backdrop-blur-sm border border-[#2F3A4C] outline-none shadow-inner
                       focus:border-[#37B5AC]/50 focus:bg-[#1E2835] transition-all" />
        </div>

        {/* Sub-header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between mb-6 relative gap-3 sm:gap-0 px-2 sm:px-0">
          <div className="z-10 bg-[#0A111A]/60 backdrop-blur-md pb-2 sm:pr-4 rounded-xl">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight">High-Performance Data Table</h2>
            <p className="text-slate-500 text-xs sm:text-sm mt-1">
              {isLoading && 'Connecting to backend...'}
              {status === 'scraping' && <span className="text-amber-400">Turbo scraping in progress — {progress.pct}% ({progress.pages_done}/{progress.total_pages} pages)</span>}
              {status === 'fetching_ratings' && <span className="text-amber-400">JIT GraphQL Fetch in progress — resolving real baseline ratings...</span>}
              {isLive && `${filtered.length.toLocaleString()} of ${meta.total.toLocaleString()} participants · ${meta.contest}`}
              {status === 'error' && <span className="text-rose-500">Error: {error}</span>}
            </p>
          </div>
          <div className="z-10 text-[9px] sm:text-[10px] font-mono text-slate-400 uppercase tracking-widest
                          bg-[#1A2633] px-3 py-1 rounded-full border border-slate-700 shadow-[0_0_15px_rgba(55,181,172,0.1)]">
            V-SYNC: ENABLED
          </div>
        </div>

        {/* Progress bar — visible during scraping */}
        <AnimatePresence>
          {isScraping && (
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="mb-6 rounded-2xl border border-amber-500/20 p-4 sm:p-5 mx-2 sm:mx-0"
              style={{ background: 'rgba(251,191,36,0.05)' }}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-3 gap-2 sm:gap-0">
                <div className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                  <span className="text-xs sm:text-sm font-semibold text-amber-400">
                    {status === 'fetching_ratings' ? 'Resolving Real Ratings...' : 'Turbo Scraping in Progress'}
                  </span>
                </div>
                <span className="text-[10px] sm:text-xs font-mono text-slate-500">
                  {status === 'fetching_ratings' ? (
                    'Dynamic Fetch'
                  ) : (
                    <>{progress.pages_done} / {progress.total_pages || '?'} pages · ETA ~{
                      progress.total_pages
                        ? Math.max(0, Math.round((progress.total_pages - progress.pages_done) * 0.65 / 60))
                        : '?'
                    } min</>
                  )}
                </span>
              </div>
              <div className="w-full h-1.5 sm:h-2 rounded-full bg-slate-800 overflow-hidden">
                <motion.div
                  animate={{ width: `${Math.max(2, progress.pct)}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut' }}
                  className="h-full rounded-full"
                  style={{ background: 'linear-gradient(90deg, #f97316, #fbbf24)' }} />
              </div>
              <p className="text-[10px] sm:text-xs text-slate-500 mt-2">
                {status === 'fetching_ratings'
                  ? 'Packing users into JIT GraphQL batch requests (15 concurrently) to gather baseline ratings.'
                  : 'Using Turbo Stealth profile (12 concurrent). Results will auto-load when complete.'}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex gap-6 items-start relative">

          {/* Player Focus Overlay / Sidebar */}
          <AnimatePresence>
            {selectedUser && (
              <>
                {/* Mobile Backdrop Overlay */}
                <motion.div
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="fixed inset-0 bg-[#050a11]/80 backdrop-blur-sm z-40 lg:hidden"
                  onClick={() => setSelectedUser(null)}
                />

                {/* Sliding Drawer (Mobile) or Static Sidebar (Desktop) */}
                <motion.div
                  initial={{ maxWidth: 0, opacity: 0, x: -20 }}
                  animate={{ maxWidth: 400, opacity: 1, x: 0 }}
                  exit={{ maxWidth: 0, opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                  className="fixed inset-y-0 left-0 z-50 lg:relative lg:z-auto shrink-0 bg-[#0A111A] lg:bg-transparent shadow-2xl lg:shadow-none overflow-hidden"
                >
                  <div className="w-[85vw] max-w-[350px] lg:w-[350px] h-full lg:h-auto overflow-y-auto lg:overflow-visible">
                    <UserDetailSidebar user={selectedUser} totalParticipants={meta.total} onClose={() => setSelectedUser(null)} />
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>

          {/* Table card */}
          <div className="flex-1 w-full min-w-0 border border-[#37B5AC]/40 rounded-xl sm:rounded-2xl overflow-hidden shadow-[0_0_25px_rgba(55,181,172,0.15)] relative"
            style={{ background: 'rgba(15,22,35,0.7)', transition: 'all 0.3s' }}>
            {(isLoading || status === 'idle') ? <SkeletonTable />
              : isScraping ? <ScrapingPlaceholder pct={progress.pct} />
                : status === 'error' ? <ErrorState message={error} onRetry={refetch} />
                  : filtered.length === 0 ? <EmptyState />
                    : <LeaderboardTable users={filtered} onRowClick={(u) => setSelectedUser(u)} />
            }
          </div>
        </div>
      </main>

      {/* Close dropdown on outside click */}
      {dropdownOpen && <div className="fixed inset-0 z-30" onClick={() => setDropdownOpen(false)} />}
    </div>
  );
};

// ─── Virtualized Table ────────────────────────────────────────────────────────
const COL = 'grid-cols-[70px_1fr_80px_130px_130px_140px_150px]';

const LeaderboardTable = ({ users, onRowClick }) => {
  const parentRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: users.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 12,
  });

  return (
    <div ref={parentRef} className="overflow-x-auto overflow-y-auto custom-scrollbar" style={{ maxHeight: '72vh' }}>
      {/* FIX 1: Increased minWidth from 800 to 900 so the flexbox grid 
        never crushes the username column on tiny screens. 
      */}
      <div style={{ minWidth: 900 }}>
        {/* Header */}
        <div className={cn('sticky top-0 z-10 grid gap-4 px-6 py-3 border-b border-slate-800 text-[11px] font-bold uppercase tracking-wider text-slate-500', COL)}
          style={{ background: 'rgba(15,23,42,0.97)', backdropFilter: 'blur(8px)' }}>
          <div>Rank</div><div>Username</div><div>Score</div>
          <div>Finish Time</div><div>Prev Rating</div><div>Delta</div><div>Pred Rating</div>
        </div>

        {/* Rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
          {rowVirtualizer.getVirtualItems().map(vRow => {
            const u = users[vRow.index];
            const isTop = u.global_rank <= TOP_RANK_N;
            const isPos = u.predicted_delta >= 0;
            return (
              <div key={vRow.key} data-index={vRow.index} ref={rowVirtualizer.measureElement}
                onClick={() => onRowClick(u)}
                className={cn('absolute top-0 left-0 w-full grid gap-4 px-6 py-3.5 border-b cursor-pointer transition-all group', COL,
                  isTop ? 'border-[#37B5AC]/30 hover:bg-[#37B5AC]/10 z-10' : 'border-slate-700/30 hover:bg-[#1A2633]')}
                style={{
                  transform: `translateY(${vRow.start}px)`,
                  background: isTop ? 'rgba(55,181,172,0.05)' : undefined,
                  boxShadow: isTop ? 'inset 3px 0 0 0 rgba(55,181,172,0.8)' : undefined,
                }}>
                {/* Rank */}
                <div className={cn('font-mono font-semibold text-sm flex items-center gap-1', isTop ? 'text-[#FBBF24]' : 'text-slate-500')}>
                  {isTop && <Trophy className="w-3 h-3" />}{u.global_rank}
                </div>

                {/* Username - FIX 2: Restructured flexbox to prevent text collapsing */}
                <div className="font-semibold text-[#60A5FA] text-sm group-hover:text-blue-300 transition-colors flex items-center min-w-0">
                  <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${u.username}`} className="w-6 h-6 rounded-full bg-slate-800 shrink-0 mr-2" />
                  <span className="truncate">{u.username}</span>
                </div>

                {/* Score */}
                <div className="text-slate-300 font-mono text-sm">{u.score ?? '—'}</div>
                {/* Finish Time */}
                <div className="text-slate-400 font-mono text-sm">{fmtTime(u.finish_time)}</div>
                {/* Prev Rating */}
                <div className="text-slate-400 font-mono text-sm">{u.previous_rating.toFixed(0)}</div>
                {/* Delta Layout */}
                <div className="flex items-center gap-3">
                  <span className={cn('font-bold font-mono text-xs w-20 text-right flex items-center justify-end gap-1.5', isPos ? 'text-[#37B5AC]' : 'text-[#D9455B]')} style={{ opacity: 0.95 }}>
                    {isPos ? `+${u.predicted_delta.toFixed(1)} ▲` : `${u.predicted_delta.toFixed(1)} ▼`}
                  </span>
                  <div className="w-8 h-3.5 bg-[#202937] rounded-full relative shrink-0"
                    style={{
                      border: isPos ? '1px solid rgba(55,181,172,0.6)' : '1px solid rgba(217,69,91,0.6)',
                      boxShadow: isPos ? '0 0 8px rgba(55,181,172,0.4)' : '0 0 8px rgba(217,69,91,0.4)'
                    }}>
                    <div className={cn("absolute top-[1.5px] bottom-[1.5px] w-[14px] rounded-full", isPos ? "bg-[#37B5AC] right-[1.5px]" : "bg-[#D9455B] left-[1.5px]")}
                      style={{ boxShadow: isPos ? '0 0 6px rgba(55,181,172,0.8)' : '0 0 6px rgba(217,69,91,0.8)' }}></div>
                  </div>
                </div>
                {/* Predicted Rating */}
                <div className="font-bold font-mono text-sm text-[#FBBF24]"
                  style={{ filter: 'drop-shadow(0 0 6px rgba(251,191,36,0.3))' }}>
                  {u.predicted_rating.toFixed(0)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── Radar Component ──────────────────────────────────────────────────────
const RadarChart = () => (
  <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-[0_0_10px_rgba(45,212,191,0.3)]">
    <polygon points="50,5 95,30 80,85 20,85 5,30" fill="none" stroke="#1E293B" strokeWidth="1" />
    <polygon points="50,25 75,45 65,70 35,70 25,45" fill="none" stroke="#1E293B" strokeWidth="1" />
    <polygon points="50,40 60,55 55,65 45,65 40,55" fill="none" stroke="#1E293B" strokeWidth="1" />
    <line x1="50" y1="50" x2="50" y2="5" stroke="#1E293B" />
    <line x1="50" y1="50" x2="95" y2="30" stroke="#1E293B" />
    <line x1="50" y1="50" x2="80" y2="85" stroke="#1E293B" />
    <line x1="50" y1="50" x2="20" y2="85" stroke="#1E293B" />
    <line x1="50" y1="50" x2="5" y2="30" stroke="#1E293B" />
    <polygon points="50,15 85,35 60,80 30,70 15,40" fill="rgba(45,212,191,0.2)" stroke="#2DD4BF" strokeWidth="1.5" />
    <circle cx="50" cy="15" r="2" fill="#2DD4BF" />
    <circle cx="85" cy="35" r="2" fill="#2DD4BF" />
    <circle cx="60" cy="80" r="2" fill="#2DD4BF" />
    <circle cx="30" cy="70" r="2" fill="#2DD4BF" />
    <circle cx="15" cy="40" r="2" fill="#2DD4BF" />
    <text x="50" y="4" fontSize="5" fill="#64748B" textAnchor="middle">Rating</text>
    <text x="96" y="32" fontSize="5" fill="#64748B" textAnchor="start">Problem</text>
    <text x="82" y="89" fontSize="5" fill="#64748B" textAnchor="middle">Learn</text>
    <text x="18" y="89" fontSize="5" fill="#64748B" textAnchor="middle">Brestrg</text>
    <text x="4" y="32" fontSize="5" fill="#64748B" textAnchor="end">Speed</text>
  </svg>
);

// ─── Player Focus Sidebar ─────────────────────────────────────────────────
const UserDetailSidebar = ({ user, totalParticipants, onClose }) => {
  return (
    <div className="flex flex-col h-full lg:h-[72vh] rounded-none lg:rounded-2xl border-0 lg:border border-slate-700/50 shadow-none lg:shadow-[0_0_30px_rgba(45,212,191,0.05)] overflow-hidden"
      style={{ background: 'rgba(15,22,35,0.95)', backdropFilter: 'blur(20px)' }}>
      {/* Header */}
      <div className="px-5 py-6 lg:py-4 flex items-center justify-between border-b border-white/5">
        <span className="font-semibold text-white tracking-wide text-sm">Player Focus</span>
        <button onClick={onClose} className="p-2 -mr-2"><ChevronDown className="w-5 h-5 lg:w-4 lg:h-4 text-slate-500 lg:-rotate-90 hover:text-white" /></button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-auto p-5 flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full border-2 border-[#2DD4BF] p-0.5 overflow-hidden shadow-[0_0_10px_rgba(45,212,191,0.4)]">
            <img src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`} className="w-full h-full rounded-full bg-slate-800" />
          </div>
          <div>
            <h3 className="font-bold text-white text-base tracking-wide truncate max-w-[180px]">{user.username}</h3>
            <p className="text-[11px] text-slate-500 uppercase tracking-widest mt-0.5">Avatar</p>
          </div>
        </div>

        <div className="h-32 flex justify-center items-center">
          <RadarChart />
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between items-end mb-1">
              <span className="text-xs font-semibold text-[#2DD4BF]">Speed</span>
              <span className="text-[10px] text-slate-400 font-mono">{fmtTime(user.finish_time)}</span>
            </div>
            <div className="h-1 bg-[#1A283B] rounded">
              <div className="h-full bg-[#2DD4BF] rounded shadow-[0_0_8px_#2DD4BF]" style={{ width: `${Math.max(5, 100 - (user.finish_time / 5400) * 100)}%` }}></div>
            </div>
          </div>
          <div>
            <div className="flex justify-between items-end mb-1">
              <span className="text-xs font-semibold text-[#60A5FA]">Problem Solving</span>
              <span className="text-[10px] text-slate-400 font-mono">Score: {user.score ?? 0}</span>
            </div>
            <div className="h-1 bg-[#1A283B] rounded">
              <div className="h-full bg-[#60A5FA] rounded shadow-[0_0_8px_#60A5FA]" style={{ width: `${Math.min(100, Math.max(5, ((user.score || 0) / 25) * 100))}%` }}></div>
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-white/5">
          <h4 className="text-xs font-semibold text-slate-300 mb-3">Real-Time Performance</h4>
          <div className="flex flex-col gap-2.5">
            <div className="flex justify-between items-center text-[10px] font-mono">
              <span className="text-[#60A5FA]">Time Taken</span>
              <span className="text-slate-500">{fmtTime(user.finish_time)}</span>
            </div>
          </div>
        </div>

        <div className="pt-2 pb-6 lg:pb-0">
          <h4 className="text-[11px] font-semibold text-slate-300 uppercase tracking-widest">Predictive Insights</h4>
          <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
            Your player insights will show his future performance in this weekend based on continuous metric tracking.
          </p>
        </div>
      </div>
    </div>
  );
};

// ─── Helper Components ────────────────────────────────────────────────────────
const SkeletonTable = () => (
  <div className="p-6 space-y-3 animate-pulse">
    {[...Array(14)].map((_, i) => (
      <div key={i} className="h-10 rounded-xl bg-slate-800/50" style={{ opacity: 1 - i * 0.05 }} />
    ))}
  </div>
);

const ScrapingPlaceholder = ({ pct }) => (
  <div className="flex flex-col items-center justify-center py-24 gap-5">
    <div className="relative w-20 h-20">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(51,65,85,0.5)" strokeWidth="3" />
        <circle cx="18" cy="18" r="15" fill="none" stroke="#f97316" strokeWidth="3"
          strokeDasharray={`${pct * 0.942} 94.2`} strokeLinecap="round" />
      </svg>
      <Loader2 className="absolute inset-0 m-auto w-8 h-8 text-orange-400 animate-spin" />
    </div>
    <div className="text-center">
      <h3 className="text-lg font-bold text-amber-400">{pct.toFixed(0)}% complete</h3>
      <p className="text-slate-500 text-sm mt-1">Turbo scraping leaderboard data from LeetCode...</p>
      <p className="text-slate-600 text-xs mt-1">Results will appear automatically when done</p>
    </div>
  </div>
);

const EmptyState = () => (
  <div className="flex flex-col items-center justify-center py-24 gap-4">
    <div className="w-14 h-14 rounded-full bg-slate-800/50 flex items-center justify-center">
      <Search className="w-6 h-6 text-slate-600" />
    </div>
    <h3 className="text-base font-semibold">No users found</h3>
    <p className="text-slate-500 text-sm">Try a different username or rank number.</p>
  </div>
);

const ErrorState = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center py-24 gap-4">
    <div className="w-14 h-14 rounded-full flex items-center justify-center"
      style={{ background: 'rgba(244,63,94,0.1)', border: '1px solid rgba(244,63,94,0.2)' }}>
      <WifiOff className="w-6 h-6 text-rose-500" />
    </div>
    <div className="text-center">
      <h3 className="text-base font-semibold text-rose-400">Cannot reach API</h3>
      <p className="text-slate-500 text-sm mt-1 font-mono">{message}</p>
    </div>
    <button onClick={onRetry}
      className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors">
      <RefreshCw className="w-4 h-4" /> Retry
    </button>
  </div>
);

export default App;