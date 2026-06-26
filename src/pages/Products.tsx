import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from '../utils/firebase';
import { useAuth } from '../contexts/AuthContext';
import { isClubAdmin } from '../utils/helpers';
import { useClubId } from '../hooks/useClubId';
import type { Coupon, PricingTier, Product } from '../types';
import { quotePrice, selectActivePricingTier } from '../utils/pricing';

// Club-admin tool for creating + editing chargeable Products. A Product
// owns its tiered pricing schedule (Early Bird → Standard → Late, with
// optional date windows) and its own coupon codes. The public /register
// form quotes through quotePrice() and snapshots the resolved tier +
// coupon onto each Registration, so editing here doesn't change what
// past families were quoted — only future submissions feel it.

const AGE_GROUP_OPTIONS = ['U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14', 'U15', 'U16', 'U17', 'U18'];

const PRODUCT_TYPES: Array<{ value: Product['type']; label: string }> = [
  { value: 'registration', label: 'Registration' },
  { value: 'tournament', label: 'Tournament' },
  { value: 'fee', label: 'Fee' },
  { value: 'merch', label: 'Merch' },
  { value: 'other', label: 'Other' },
];

const Products: React.FC = () => {
  const { userData } = useAuth();
  const allowed = isClubAdmin(userData);
  const { clubId, loading: clubIdLoading } = useClubId();

  const [products, setProducts] = useState<Product[]>([]);
  const [seasons, setSeasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = async () => {
    if (!allowed || !clubId) return;
    try {
      setLoading(true);
      const [pSnap, sSnap] = await Promise.all([
        getDocs(query(collection(db, 'products'), where('clubId', '==', clubId), orderBy('createdAt', 'desc'))),
        getDocs(query(collection(db, 'seasons'), orderBy('createdAt', 'desc'))),
      ]);
      setProducts(pSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) }) as Product));
      setSeasons(sSnap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
    } catch (err) {
      console.warn('product load failed', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [allowed, clubId]);

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm">
        Club admins only.
      </div>
    );
  }

  if (!clubId && !clubIdLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8 text-bone/65 text-sm text-center">
        <div className="max-w-md">
          <p className="font-bold mb-1">Couldn't find your club.</p>
          <p className="text-xs">Set <code className="text-[11px] bg-charcoal-950 px-1 rounded">clubId</code> on your user doc in Firestore, or join a team in this club first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-charcoal-950 px-4 py-6 sm:py-10">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/club" className="text-[11px] font-bold uppercase tracking-widest text-bone/50 hover:text-bone/85">
              ← Club
            </Link>
            <h1 className="text-2xl font-black text-bone mt-1">Products</h1>
            <p className="text-sm text-bone/65">
              Anything chargeable — registration fees, tournament entry, merch.
              Each product owns its pricing schedule and coupon codes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/150 text-white text-sm font-bold"
          >
            + New product
          </button>
        </div>

        {loading ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-6 text-sm text-bone/50">Loading…</div>
        ) : products.length === 0 ? (
          <div className="bg-charcoal-900 rounded-2xl ring-1 ring-white/10 p-8 text-center">
            <p className="text-sm text-bone/65 mb-3">
              No products yet. Create your first one — registration fees are the usual starter.
            </p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="px-3 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/150 text-white text-sm font-bold"
            >
              Create product
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {products.map(p => (
              <ProductCard
                key={p.id}
                product={p}
                seasonName={seasons.find(s => s.id === p.metadata?.seasonId)?.name}
                onEdit={() => setEditing(p)}
              />
            ))}
          </div>
        )}
      </div>

      {(creating || editing) && (
        <ProductEditor
          product={editing}
          clubId={clubId!}
          userData={userData}
          seasons={seasons}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void reload(); }}
        />
      )}
    </div>
  );
};

// ── Product card ────────────────────────────────────────────────

const ProductCard: React.FC<{ product: Product; seasonName?: string; onEdit: () => void }> = ({ product, seasonName, onEdit }) => {
  const activeTier = useMemo(() => selectActivePricingTier(product), [product]);
  const quote = useMemo(() => quotePrice(product), [product]);
  const couponCount = (product.coupons || []).filter(c => c.isActive !== false).length;

  return (
    <button
      type="button"
      onClick={onEdit}
      className="text-left bg-charcoal-900 rounded-2xl ring-1 ring-white/10 hover:ring-brand-primary-soft p-4 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-extrabold tracking-widest uppercase text-bone/50">
              {product.type}
            </span>
            {!product.isActive && (
              <span className="text-[10px] font-extrabold tracking-widest uppercase bg-charcoal-950 text-bone/50 ring-1 ring-white/15 px-1.5 py-0.5 rounded">
                Archived
              </span>
            )}
          </div>
          <h3 className="font-black text-bone truncate">{product.name}</h3>
          {seasonName && (
            <p className="text-[11px] text-bone/50 mt-0.5">{seasonName}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="font-black text-bone">${(quote.totalCents / 100).toFixed(2)}</div>
          {activeTier && (
            <div className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">
              {activeTier.label}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px] text-bone/65">
        <span className="px-2 py-0.5 rounded bg-charcoal-950 ring-1 ring-white/10">
          {(product.pricingTiers || []).length} tier{(product.pricingTiers || []).length === 1 ? '' : 's'}
        </span>
        <span className="px-2 py-0.5 rounded bg-charcoal-950 ring-1 ring-white/10">
          {couponCount} coupon{couponCount === 1 ? '' : 's'}
        </span>
        {(product.metadata?.ageGroups || []).length > 0 && (
          <span className="px-2 py-0.5 rounded bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 text-brand-primary-soft">
            {(product.metadata!.ageGroups as string[]).join(', ')}
          </span>
        )}
        {(product.stripeSurchargeBps ?? 0) > 0 && (
          <span className="px-2 py-0.5 rounded bg-violet-500/15 ring-1 ring-violet-200 text-violet-300">
            +{((product.stripeSurchargeBps ?? 0) / 100).toFixed(2)}% processing
          </span>
        )}
      </div>
    </button>
  );
};

// ── Editor modal ────────────────────────────────────────────────

const blankTier = (): PricingTier => ({
  id: `t_${Math.random().toString(36).slice(2, 9)}`,
  label: 'Standard',
  priceCents: 0,
  startsAt: null,
  endsAt: null,
  isDefault: true,
});

const blankCoupon = (): Coupon => ({
  id: `c_${Math.random().toString(36).slice(2, 9)}`,
  code: '',
  discountCents: 0,
  maxUses: null,
  usesCount: 0,
  isActive: true,
});

interface EditorProps {
  product: Product | null;
  clubId: string;
  userData: any;
  seasons: any[];
  onClose: () => void;
  onSaved: () => void;
}

const ProductEditor: React.FC<EditorProps> = ({ product, clubId, userData, seasons, onClose, onSaved }) => {
  const isNew = !product;
  const [name, setName] = useState(product?.name || '');
  const [type, setType] = useState<Product['type']>(product?.type || 'registration');
  const [description, setDescription] = useState(product?.description || '');
  const [isActive, setIsActive] = useState(product?.isActive ?? true);
  const [seasonId, setSeasonId] = useState<string>(product?.metadata?.seasonId || '');
  const [ageGroups, setAgeGroups] = useState<string[]>(product?.metadata?.ageGroups || []);
  const [surchargeBps, setSurchargeBps] = useState<number>(product?.stripeSurchargeBps ?? 0);
  const [tiers, setTiers] = useState<PricingTier[]>(
    product?.pricingTiers && product.pricingTiers.length > 0
      ? product.pricingTiers.map(t => ({ ...t }))
      : [blankTier()],
  );
  const [coupons, setCoupons] = useState<Coupon[]>(
    (product?.coupons || []).map(c => ({ ...c })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = !!name.trim() && tiers.length > 0 && tiers.every(t => t.label.trim() && t.priceCents >= 0) && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const cleanTiers = tiers.map(t => ({
        id: t.id,
        label: t.label.trim(),
        priceCents: Math.round(Number(t.priceCents) || 0),
        startsAt: t.startsAt ? new Date(t.startsAt as any) : null,
        endsAt: t.endsAt ? new Date(t.endsAt as any) : null,
        isDefault: !!t.isDefault,
      }));
      const cleanCoupons = coupons
        .filter(c => c.code.trim())
        .map(c => ({
          id: c.id,
          code: c.code.trim().toUpperCase(),
          discountCents: c.discountCents ? Math.round(Number(c.discountCents)) : undefined,
          discountPercent: c.discountPercent ? Math.round(Number(c.discountPercent)) : undefined,
          maxUses: c.maxUses ? Number(c.maxUses) : null,
          usesCount: c.usesCount ?? 0,
          expiresAt: c.expiresAt ? new Date(c.expiresAt as any) : null,
          isActive: c.isActive !== false,
          note: c.note?.trim() || undefined,
          createdAt: (c as any).createdAt || serverTimestamp(),
          createdBy: (c as any).createdBy || userData?.uid,
        }));

      const metadata: Record<string, any> = {};
      if (seasonId) metadata.seasonId = seasonId;
      if (ageGroups.length > 0) metadata.ageGroups = ageGroups;

      const payload: any = {
        clubId,
        type,
        name: name.trim(),
        description: description.trim() || undefined,
        isActive,
        pricingTiers: cleanTiers,
        coupons: cleanCoupons,
        stripeSurchargeBps: Math.max(0, Math.round(Number(surchargeBps) || 0)),
        metadata,
        updatedAt: serverTimestamp(),
      };

      if (isNew) {
        payload.createdAt = serverTimestamp();
        payload.createdBy = userData?.uid;
        payload.createdByName = userData?.name;
        const id = `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await setDoc(doc(db, 'products', id), payload);
      } else {
        await updateDoc(doc(db, 'products', product!.id), payload);
      }
      onSaved();
    } catch (err: any) {
      console.error('product save failed', err);
      setError(err?.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const updateTier = (i: number, patch: Partial<PricingTier>) => {
    setTiers(prev => prev.map((t, idx) => idx === i ? { ...t, ...patch } : t));
  };

  const updateCoupon = (i: number, patch: Partial<Coupon>) => {
    setCoupons(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch } : c));
  };

  // Live quote preview using the current draft values.
  const draftProduct: Pick<Product, 'pricingTiers' | 'coupons' | 'stripeSurchargeBps'> = {
    pricingTiers: tiers.map(t => ({
      ...t,
      priceCents: Math.round(Number(t.priceCents) || 0),
      startsAt: t.startsAt ? new Date(t.startsAt as any) : null,
      endsAt: t.endsAt ? new Date(t.endsAt as any) : null,
    })),
    coupons,
    stripeSurchargeBps: surchargeBps,
  };
  const livePreview = quotePrice(draftProduct);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-6 overflow-y-auto">
      <div className="bg-charcoal-900 w-full sm:max-w-2xl sm:rounded-2xl overflow-hidden flex flex-col max-h-[100vh]">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h2 className="font-black text-bone">{isNew ? 'New product' : 'Edit product'}</h2>
          <button type="button" onClick={onClose} className="text-bone/40 hover:text-bone/85 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <FieldRow>
            <Field label="Name" required>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring 2026 Registration" className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
            </Field>
            <Field label="Type">
              <select value={type} onChange={(e) => setType(e.target.value as Product['type'])} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm">
                {PRODUCT_TYPES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </FieldRow>

          <Field label="Description (optional)">
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
          </Field>

          {type === 'registration' && (
            <>
              <FieldRow>
                <Field label="Season">
                  <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm">
                    <option value="">— None (applies to any season) —</option>
                    {seasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Stripe processing surcharge (basis points)">
                  <input type="number" min={0} max={1000} value={surchargeBps} onChange={(e) => setSurchargeBps(Number(e.target.value))} className="w-full px-3 py-2 rounded-lg ring-1 ring-white/10 focus:ring-2 focus:ring-brand-primary-soft text-sm" />
                  <p className="text-[10px] text-bone/50 mt-1">100 = 1%. Stripe's flat take is ~290bps. Leave 0 to absorb fees.</p>
                </Field>
              </FieldRow>

              <Field label="Age groups (optional — restricts product to these)">
                <div className="flex flex-wrap gap-1.5">
                  {AGE_GROUP_OPTIONS.map(ag => {
                    const on = ageGroups.includes(ag);
                    return (
                      <button
                        key={ag}
                        type="button"
                        onClick={() => setAgeGroups(on ? ageGroups.filter(x => x !== ag) : [...ageGroups, ag])}
                        className={`px-2.5 py-1 rounded text-[11px] font-bold ring-1 ${
                          on
                            ? 'bg-brand-primary text-white ring-brand-primary'
                            : 'bg-charcoal-900 text-bone/65 ring-white/10 hover:ring-brand-primary-soft'
                        }`}
                      >
                        {ag}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </>
          )}

          {/* Pricing tiers */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-bone/85">Pricing tiers</h3>
              <button
                type="button"
                onClick={() => setTiers([...tiers, blankTier()])}
                className="text-[11px] font-bold text-brand-primary-soft hover:text-brand-primary-soft"
              >
                + Add tier
              </button>
            </div>
            <div className="space-y-2">
              {tiers.map((t, i) => (
                <div key={t.id} className="bg-white/[0.04] rounded-xl ring-1 ring-white/10 p-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <input
                      value={t.label}
                      onChange={(e) => updateTier(i, { label: e.target.value })}
                      placeholder="Early Bird"
                      className="col-span-2 px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                    />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-bone/50">$</span>
                      <input
                        type="number"
                        min={0}
                        value={t.priceCents == null ? '' : (t.priceCents / 100).toString()}
                        onChange={(e) => updateTier(i, { priceCents: Math.round(Number(e.target.value) * 100) })}
                        placeholder="0.00"
                        step="0.01"
                        className="w-full px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                      />
                    </div>
                    <input
                      type="date"
                      value={toDateInput(t.startsAt)}
                      onChange={(e) => updateTier(i, { startsAt: e.target.value ? new Date(e.target.value) : null })}
                      className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                    />
                    <input
                      type="date"
                      value={toDateInput(t.endsAt)}
                      onChange={(e) => updateTier(i, { endsAt: e.target.value ? new Date(e.target.value) : null })}
                      className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <label className="flex items-center gap-1.5 text-bone/65">
                      <input
                        type="checkbox"
                        checked={!!t.isDefault}
                        onChange={(e) => setTiers(prev => prev.map((tt, idx) => ({ ...tt, isDefault: idx === i ? e.target.checked : (e.target.checked ? false : tt.isDefault) })))}
                      />
                      Default tier (used when no date window matches)
                    </label>
                    {tiers.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setTiers(tiers.filter((_, idx) => idx !== i))}
                        className="text-rose-300 hover:text-rose-800 font-bold"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Coupons */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-bone/85">Coupon codes</h3>
              <button
                type="button"
                onClick={() => setCoupons([...coupons, blankCoupon()])}
                className="text-[11px] font-bold text-brand-primary-soft hover:text-brand-primary-soft"
              >
                + Add coupon
              </button>
            </div>
            {coupons.length === 0 ? (
              <p className="text-[11px] text-bone/50">None. Add one above to offer a promo code at checkout.</p>
            ) : (
              <div className="space-y-2">
                {coupons.map((c, i) => (
                  <div key={c.id} className="bg-white/[0.04] rounded-xl ring-1 ring-white/10 p-3 space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input
                        value={c.code}
                        onChange={(e) => updateCoupon(i, { code: e.target.value.toUpperCase() })}
                        placeholder="EARLYBIRD"
                        className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm uppercase tracking-wider font-bold"
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-bone/50">$</span>
                        <input
                          type="number"
                          min={0}
                          value={c.discountCents == null ? '' : (c.discountCents / 100).toString()}
                          onChange={(e) => updateCoupon(i, { discountCents: Math.round(Number(e.target.value) * 100), discountPercent: undefined })}
                          placeholder="0.00"
                          step="0.01"
                          className="w-full px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={c.discountPercent ?? ''}
                          onChange={(e) => updateCoupon(i, { discountPercent: e.target.value ? Number(e.target.value) : undefined, discountCents: undefined })}
                          placeholder="%"
                          className="w-full px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                        />
                        <span className="text-xs text-bone/50">%</span>
                      </div>
                      <input
                        type="number"
                        min={0}
                        value={c.maxUses ?? ''}
                        onChange={(e) => updateCoupon(i, { maxUses: e.target.value ? Number(e.target.value) : null })}
                        placeholder="Max uses"
                        className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                      />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 items-center">
                      <input
                        type="date"
                        value={toDateInput(c.expiresAt)}
                        onChange={(e) => updateCoupon(i, { expiresAt: e.target.value ? new Date(e.target.value) : null })}
                        className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                      />
                      <input
                        value={c.note || ''}
                        onChange={(e) => updateCoupon(i, { note: e.target.value })}
                        placeholder="Note (admin only)"
                        className="px-2.5 py-1.5 rounded-md ring-1 ring-white/10 text-sm"
                      />
                      <div className="flex items-center justify-between text-[11px] text-bone/65">
                        <label className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={c.isActive !== false}
                            onChange={(e) => updateCoupon(i, { isActive: e.target.checked })}
                          />
                          Active
                        </label>
                        <span className="text-bone/40">Used {c.usesCount ?? 0}×</span>
                        <button
                          type="button"
                          onClick={() => setCoupons(coupons.filter((_, idx) => idx !== i))}
                          className="text-rose-300 hover:text-rose-800 font-bold"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Live preview */}
          <div className="rounded-xl bg-brand-primary/15 ring-1 ring-brand-primary-soft/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-brand-primary-soft">Live quote</span>
              <span className="text-[11px] text-brand-primary-soft">{livePreview.tier?.label || 'No active tier'}</span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="font-black text-bone">${(livePreview.totalCents / 100).toFixed(2)}</span>
              <span className="text-[11px] text-bone/65">
                base ${(livePreview.baseCents / 100).toFixed(2)}
                {livePreview.surchargeCents > 0 && ` + $${(livePreview.surchargeCents / 100).toFixed(2)} fees`}
              </span>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-bone/85">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active (uncheck to archive without deleting)
          </label>

          {error && (
            <div className="rounded-lg bg-rose-500/15 ring-1 ring-rose-300 px-3 py-2 text-sm text-rose-300">{error}</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg text-sm font-bold text-bone/65 hover:text-bone">Cancel</button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-brand-primary hover:bg-brand-primary/150 disabled:opacity-50 text-white text-sm font-bold"
          >
            {saving ? 'Saving…' : isNew ? 'Create product' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Small UI bits ───────────────────────────────────────────────

const FieldRow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
);

const Field: React.FC<{ label: string; required?: boolean; children: React.ReactNode }> = ({ label, required, children }) => (
  <label className="block">
    <span className="block text-[10px] font-extrabold uppercase tracking-widest text-bone/65 mb-1">
      {label}{required && <span className="text-rose-300 ml-0.5">*</span>}
    </span>
    {children}
  </label>
);

function toDateInput(v: any): string {
  if (!v) return '';
  const d = v instanceof Date ? v : (v?.toDate?.() || new Date(v));
  if (isNaN(d.getTime?.())) return '';
  return d.toISOString().slice(0, 10);
}

export default Products;
