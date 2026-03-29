"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Profile {
  _id: string;
  name: string;
  platform: string;
}

interface ProductEntry {
  url: string;
  quantity: number;
}

interface SavedCard {
  _id: string;
  label: string;
}

interface SavedAccount {
  _id: string;
  label: string;
  maskedEmail: string;
}

interface SavedAddress {
  _id: string;
  name: string;
  maskedMobile: string;
  companyName: string;
  gstNumber: string;
  city: string;
  addressType: string;
}

export default function NewJobPage() {
  const { status } = useSession();
  const router = useRouter();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [savedCards, setSavedCards] = useState<SavedCard[]>([]);
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [savedAddresses, setSavedAddresses] = useState<SavedAddress[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Form state
  const [platform, setPlatform] = useState<"flipkart" | "amazon">("flipkart");
  const [paymentMethod, setPaymentMethod] = useState<"card" | "giftcard" | "rtgs">("card");
  const [products, setProducts] = useState<ProductEntry[]>([{ url: "", quantity: 1 }]);
  const [iterations, setIterations] = useState(1);
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const [chromeProfileId, setChromeProfileId] = useState("");

  // Payment details
  const [cardMode, setCardMode] = useState<"single" | "rotate">("single");
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [cardNumber, setCardNumber] = useState("");
  const [expiryMonth, setExpiryMonth] = useState("");
  const [expiryYear, setExpiryYear] = useState("");
  const [cvv, setCvv] = useState("");
  const [giftCardCode, setGiftCardCode] = useState("");
  const [giftCardPin, setGiftCardPin] = useState("");
  const [bankName, setBankName] = useState("");
  const [maxConcurrentTabs, setMaxConcurrentTabs] = useState(1);

  // Account rotation
  const [useAccountRotation, setUseAccountRotation] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);

  // GST Address
  const [useGstAddress, setUseGstAddress] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [checkoutPincode, setCheckoutPincode] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") {
      fetchProfiles();
      fetchSavedCards();
      fetchSavedAccounts();
      fetchSavedAddresses();
    }
  }, [status, router]);

  async function fetchProfiles() {
    const res = await fetch("/api/profiles");
    if (res.ok) {
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0) setChromeProfileId(data[0]._id);
    }
  }

  async function fetchSavedCards() {
    const res = await fetch("/api/cards");
    if (res.ok) setSavedCards(await res.json());
  }

  async function fetchSavedAccounts() {
    const res = await fetch("/api/accounts");
    if (res.ok) setSavedAccounts(await res.json());
  }

  async function fetchSavedAddresses() {
    const res = await fetch("/api/addresses");
    if (res.ok) setSavedAddresses(await res.json());
  }

  function toggleAccountSelection(accountId: string) {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId)
        ? prev.filter((id) => id !== accountId)
        : [...prev, accountId]
    );
  }

  function toggleCardSelection(cardId: string) {
    setSelectedCardIds((prev) =>
      prev.includes(cardId)
        ? prev.filter((id) => id !== cardId)
        : [...prev, cardId]
    );
  }

  function getPaymentDetails() {
    switch (paymentMethod) {
      case "card":
        return {
          cardNumber: cardNumber.replace(/\s/g, ""),
          expiry: `${expiryMonth}/${expiryYear}`,
          cvv,
        };
      case "giftcard":
        return { code: giftCardCode, pin: giftCardPin };
      case "rtgs":
        return { bankName };
    }
  }

  function addProduct() {
    setProducts([...products, { url: "", quantity: 1 }]);
  }

  function removeProduct(index: number) {
    if (products.length <= 1) return;
    setProducts(products.filter((_, i) => i !== index));
  }

  function updateProduct(index: number, field: "url" | "quantity", value: string | number) {
    const updated = [...products];
    if (field === "url") {
      updated[index].url = value as string;
    } else {
      updated[index].quantity = value as number;
    }
    setProducts(updated);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const emptyUrls = products.some((p) => !p.url.trim());
    if (emptyUrls) {
      setError("All product URLs must be filled");
      return;
    }

    if (paymentMethod === "card" && cardMode === "rotate" && selectedCardIds.length === 0) {
      setError("Select at least one saved card for rotation");
      return;
    }

    if (useAccountRotation && selectedAccountIds.length === 0) {
      setError("Select at least one account for rotation");
      return;
    }

    if (useGstAddress && !selectedAddressId) {
      setError("Select a GST address before creating the job");
      return;
    }

    if (paymentMethod === "card" && cardMode === "single") {
      const cleanNum = cardNumber.replace(/\s/g, "");
      if (cleanNum.length < 13) {
        setError("Card number must be at least 13 digits");
        return;
      }
      if (!expiryMonth || !expiryYear) {
        setError("Expiry month and year are required");
        return;
      }
      if (!cvv || cvv.length < 3) {
        setError("CVV must be at least 3 digits");
        return;
      }
    }

    setLoading(true);

    try {
      const useRotation = paymentMethod === "card" && cardMode === "rotate";
      const effectiveIterations = useAccountRotation ? selectedAccountIds.length : iterations;
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          paymentMethod,
          products: products.map((p) => ({ url: p.url.trim(), quantity: p.quantity })),
          totalQuantity: totalQuantity * effectiveIterations,
          perOrderQuantity: totalQuantity,
          intervalSeconds,
          chromeProfileId,
          ...(useRotation
            ? { cardIds: selectedCardIds }
            : { paymentDetails: getPaymentDetails() }),
          ...(useAccountRotation ? { accountIds: selectedAccountIds } : {}),
          ...(useGstAddress && selectedAddressId ? { addressIds: [selectedAddressId], checkoutPincode: checkoutPincode || undefined } : {}),
          ...(paymentMethod === "rtgs" && maxConcurrentTabs > 1 ? { maxConcurrentTabs } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create job");
        setLoading(false);
        return;
      }

      const job = await res.json();
      router.push(`/dashboard/jobs/${job._id}`);
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  const isMultiUrl = products.length > 1;
  const totalQuantity = products.reduce((sum, p) => sum + p.quantity, 0);

  const inputClass = "w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all";
  const labelClass = "block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider";

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Create New Job</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure an automated buying job</p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">&#x2715;</span>
          <span>{error}</span>
        </div>
      )}

      {profiles.length === 0 && (
        <div className="mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-yellow-400 text-sm">
          No Chrome profiles found.{" "}
          <Link href="/dashboard/profiles" className="underline hover:text-yellow-300 transition-colors">
            Create a profile
          </Link>{" "}
          first.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Platform & Payment */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Platform</label>
            <select
              value={platform}
              onChange={(e) => {
                const val = e.target.value as "flipkart" | "amazon";
                setPlatform(val);
                // Reset payment if current selection is unsupported on the new platform
                if (val === "amazon" && paymentMethod === "giftcard") setPaymentMethod("card");
                if (val === "amazon" && paymentMethod === "rtgs") setPaymentMethod("card");
              }}
              className={inputClass}
            >
              <option value="flipkart">Flipkart</option>
              <option value="amazon">Amazon</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Payment Method</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as "card" | "giftcard" | "rtgs")}
              className={inputClass}
            >
              <option value="card">Card (Credit/Debit)</option>
              <option value="giftcard" disabled={platform === "amazon"}>
                Gift Card{platform === "amazon" ? " (Coming soon)" : ""}
              </option>
              <option value="rtgs">
                RTGS / Net Banking
              </option>
            </select>
          </div>
        </div>

        {/* Chrome Profile */}
        <div>
          <label className={labelClass}>Chrome Profile</label>
          <select
            value={chromeProfileId}
            onChange={(e) => setChromeProfileId(e.target.value)}
            className={inputClass}
          >
            {profiles.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name} ({p.platform})
              </option>
            ))}
          </select>
        </div>

        {/* Products */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className={labelClass}>
              Products
              {isMultiUrl && (
                <span className="text-blue-400 ml-2 normal-case tracking-normal">
                  Multi-URL mode
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={addProduct}
              className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-all font-medium"
            >
              + Add URL
            </button>
          </div>
          <div className="space-y-3">
            {products.map((product, index) => (
              <div key={index} className="flex gap-3 items-start">
                <div className="flex-1">
                  <input
                    type="url"
                    value={product.url}
                    onChange={(e) => updateProduct(index, "url", e.target.value)}
                    required
                    className={inputClass}
                    placeholder={`https://www.${platform === "flipkart" ? "flipkart.com" : "amazon.in"}/product/...`}
                  />
                </div>
                <div className="w-24">
                  <input
                    type="number"
                    value={product.quantity}
                    onChange={(e) => updateProduct(index, "quantity", parseInt(e.target.value) || 1)}
                    min={1}
                    required
                    className={`${inputClass} text-center`}
                    title="Quantity"
                  />
                </div>
                {products.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeProduct(index)}
                    className="px-2.5 py-2.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-xl transition-all"
                    title="Remove product"
                  >
                    &#x2715;
                  </button>
                )}
              </div>
            ))}
          </div>
          {isMultiUrl && (
            <p className="text-xs text-blue-400/70 mt-2">
              Each product will be added to cart, then a single order placed for all items.
            </p>
          )}
        </div>

        {/* Order Settings */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Iterations</label>
            <input
              type="number"
              value={useAccountRotation ? selectedAccountIds.length : iterations}
              onChange={(e) => setIterations(parseInt(e.target.value) || 1)}
              min={1}
              required
              disabled={useAccountRotation}
              className={`${inputClass} ${useAccountRotation ? "opacity-50 cursor-not-allowed" : ""}`}
            />
            {useAccountRotation ? (
              <p className="text-xs text-blue-400 mt-1">Iterations set by account count</p>
            ) : (
              <p className="text-xs text-gray-600 mt-1">How many times to repeat</p>
            )}
          </div>
          <div>
            <label className={labelClass}>Interval (sec)</label>
            <input
              type="number"
              value={intervalSeconds}
              onChange={(e) => setIntervalSeconds(parseInt(e.target.value) || 0)}
              min={0}
              required
              className={inputClass}
            />
            <p className="text-xs text-gray-600 mt-1">Delay between orders</p>
          </div>
        </div>

        {iterations > 0 && (
          <div className="p-3 bg-gray-900 rounded-xl border border-gray-800 text-sm text-gray-400">
            {iterations} iteration{iterations !== 1 ? "s" : ""}
            {isMultiUrl
              ? ` — each adding ${products.length} products to cart`
              : ` — each ordering the product`
            }
            {intervalSeconds > 0 ? `, ${intervalSeconds}s delay between orders` : ""}
          </div>
        )}

        {/* Account Rotation (Flipkart only) */}
        {platform === "flipkart" && (
          <div className="space-y-4 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">Account Rotation</h3>
                <p className="text-xs text-gray-500 mt-0.5">Login with different accounts per iteration</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={useAccountRotation}
                  onChange={(e) => {
                    setUseAccountRotation(e.target.checked);
                    if (!e.target.checked) setSelectedAccountIds([]);
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {useAccountRotation && (
              <div>
                {savedAccounts.length === 0 ? (
                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-400">
                    No saved accounts.{" "}
                    <Link href="/dashboard/accounts" className="underline hover:text-yellow-300 transition-colors">
                      Add accounts
                    </Link>{" "}
                    first.
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-gray-500 mb-3">
                      Each account = 1 iteration. Bot logs in, buys, logs out, moves to next account. You enter OTP manually.
                    </p>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {savedAccounts.map((acc) => (
                        <label
                          key={acc._id}
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                            selectedAccountIds.includes(acc._id)
                              ? "border-blue-500/40 bg-blue-500/10"
                              : "border-gray-700 bg-gray-800 hover:border-gray-600"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedAccountIds.includes(acc._id)}
                            onChange={() => toggleAccountSelection(acc._id)}
                            className="accent-blue-500"
                          />
                          <div>
                            <span className="text-sm text-white">{acc.label}</span>
                            <span className="text-xs text-gray-500 ml-2 font-mono">{acc.maskedEmail}</span>
                          </div>
                        </label>
                      ))}
                    </div>
                    {selectedAccountIds.length > 0 && (
                      <p className="text-xs text-emerald-400 mt-2">
                        {selectedAccountIds.length} account{selectedAccountIds.length !== 1 ? "s" : ""} selected = {selectedAccountIds.length} iteration{selectedAccountIds.length !== 1 ? "s" : ""}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* GST Address (Flipkart only) */}
        {platform === "flipkart" && (
          <div className="space-y-4 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">GST Address & Invoice</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Verify delivery address and GST invoice details on checkout
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={useGstAddress}
                  onChange={(e) => {
                    setUseGstAddress(e.target.checked);
                    if (!e.target.checked) {
                      setSelectedAddressId("");
                      setCheckoutPincode("");
                    }
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {useGstAddress && (
              <div>
                {savedAddresses.length === 0 ? (
                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-400">
                    No saved addresses.{" "}
                    <Link href="/dashboard/addresses" className="underline hover:text-yellow-300 transition-colors">
                      Add addresses
                    </Link>{" "}
                    first.
                  </div>
                ) : (
                  <div>
                    <p className="text-xs text-gray-500 mb-3">
                      The bot will verify and correct the delivery address and GST invoice on the checkout page.
                    </p>
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {savedAddresses.map((addr) => (
                        <label
                          key={addr._id}
                          className={`block p-3 rounded-xl border cursor-pointer transition-all ${
                            selectedAddressId === addr._id
                              ? "border-blue-500/40 bg-blue-500/10"
                              : "border-gray-700 bg-gray-800 hover:border-gray-600"
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <input
                              type="radio"
                              name="addressSelection"
                              checked={selectedAddressId === addr._id}
                              onChange={() => setSelectedAddressId(addr._id)}
                              className="accent-blue-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded">
                                  {addr.gstNumber.slice(0, 2)}***{addr.gstNumber.slice(-2)}
                                </span>
                                <span className="text-sm font-medium text-white truncate">{addr.companyName}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded border ${
                                  addr.addressType === "Work"
                                    ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                    : "bg-gray-700 text-gray-400 border-gray-600"
                                }`}>
                                  {addr.addressType}
                                </span>
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5 ml-5">
                                {addr.name} &bull; {addr.city} &bull; {addr.maskedMobile}
                              </div>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                    {selectedAddressId && (
                      <p className="text-xs text-emerald-400 mt-2">
                        GST address selected. Bot will verify and correct address/GST on checkout.
                      </p>
                    )}

                    {/* Checkout Pincode Override */}
                    <div className="mt-4 pt-4 border-t border-gray-800">
                      <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                        Checkout Pincode Override (optional)
                      </label>
                      <input
                        type="text"
                        value={checkoutPincode}
                        onChange={(e) => setCheckoutPincode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="Leave blank to use address pincode"
                        maxLength={6}
                        className={`${inputClass} text-center`}
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Use this to override the pincode at checkout time (e.g., for COD orders in different serviceable areas)
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Payment Details — Card */}
        {paymentMethod === "card" && (
          <div className="space-y-4 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-200">Card Details</h3>
              <div className="flex bg-gray-800 rounded-lg p-0.5 text-xs border border-gray-700">
                <button
                  type="button"
                  onClick={() => setCardMode("single")}
                  className={`px-3 py-1.5 rounded-md transition-all font-medium ${
                    cardMode === "single"
                      ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Single Card
                </button>
                <button
                  type="button"
                  onClick={() => setCardMode("rotate")}
                  className={`px-3 py-1.5 rounded-md transition-all font-medium ${
                    cardMode === "rotate"
                      ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  Rotate Cards
                </button>
              </div>
            </div>

            {cardMode === "single" ? (
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>Card Number</label>
                  <input
                    type="text"
                    value={cardNumber}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/\D/g, "").slice(0, 16);
                      setCardNumber(raw.replace(/(\d{4})(?=\d)/g, "$1 "));
                    }}
                    placeholder="1234 5678 9012 3456"
                    required
                    maxLength={19}
                    className={`${inputClass} font-mono tracking-wider`}
                  />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>Month</label>
                    <select value={expiryMonth} onChange={(e) => setExpiryMonth(e.target.value)} required className={inputClass}>
                      <option value="">MM</option>
                      {Array.from({ length: 12 }, (_, i) => {
                        const m = String(i + 1).padStart(2, "0");
                        return <option key={m} value={m}>{m}</option>;
                      })}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Year</label>
                    <select value={expiryYear} onChange={(e) => setExpiryYear(e.target.value)} required className={inputClass}>
                      <option value="">YYYY</option>
                      {Array.from({ length: 12 }, (_, i) => {
                        const y = String(new Date().getFullYear() + i);
                        return <option key={y} value={y}>{y}</option>;
                      })}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>CVV</label>
                    <input
                      type="password"
                      value={cvv}
                      onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      placeholder="***"
                      required
                      maxLength={4}
                      className={`${inputClass} font-mono tracking-widest`}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div>
                {savedCards.length === 0 ? (
                  <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-400">
                    No saved cards.{" "}
                    <Link href="/dashboard/cards" className="underline hover:text-yellow-300 transition-colors">
                      Add cards
                    </Link>{" "}
                    first.
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-gray-500 mb-3">
                      Cards cycle in order: 1, 2, 3, 1, 2, 3...
                    </p>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {savedCards.map((card) => (
                        <label
                          key={card._id}
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                            selectedCardIds.includes(card._id)
                              ? "border-blue-500/40 bg-blue-500/10"
                              : "border-gray-700 bg-gray-800 hover:border-gray-600"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedCardIds.includes(card._id)}
                            onChange={() => toggleCardSelection(card._id)}
                            className="accent-blue-500"
                          />
                          <span className="text-sm text-white">{card.label}</span>
                        </label>
                      ))}
                    </div>
                    {selectedCardIds.length > 0 && (
                      <p className="text-xs text-emerald-400 mt-2">
                        {selectedCardIds.length} card{selectedCardIds.length !== 1 ? "s" : ""} selected
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Payment Details — Gift Card */}
        {paymentMethod === "giftcard" && (
          <div className="space-y-4 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200">Gift Card Details</h3>
            <div>
              <label className={labelClass}>Gift Card Code</label>
              <input
                type="text"
                value={giftCardCode}
                onChange={(e) => setGiftCardCode(e.target.value)}
                placeholder="Enter gift card code"
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>PIN</label>
              <input
                type="text"
                value={giftCardPin}
                onChange={(e) => setGiftCardPin(e.target.value)}
                placeholder="PIN (if applicable)"
                className={inputClass}
              />
            </div>
          </div>
        )}

        {/* Payment Details — RTGS */}
        {paymentMethod === "rtgs" && (
          <div className="space-y-4 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200">RTGS / Net Banking</h3>
            <div>
              <label className={labelClass}>Bank Name</label>
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="e.g., HDFC, SBI, ICICI"
                required
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Max Concurrent Tabs</label>
              <select
                value={maxConcurrentTabs}
                onChange={(e) => setMaxConcurrentTabs(parseInt(e.target.value))}
                className={inputClass}
              >
                <option value={1}>1 tab at a time</option>
                <option value={2}>2 tabs at a time</option>
                <option value={3}>3 tabs at a time</option>
                <option value={5}>5 tabs at a time</option>
                <option value={10}>10 tabs at a time</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {maxConcurrentTabs > 1
                  ? `Opens ${maxConcurrentTabs} tabs simultaneously. All bank portals stay open until manually authenticated.`
                  : "Single-tab mode — one order at a time."}
              </p>
            </div>
            {maxConcurrentTabs > 1 && (
              <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-xs text-yellow-400">
                Multi-tab mode: bot opens {maxConcurrentTabs} tabs in parallel, each with its own bank portal. Complete all authentications manually, then the bot proceeds to the next batch.
              </div>
            )}
            {maxConcurrentTabs === 1 && (
              <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-xs text-yellow-400">
                Net Banking is semi-automated. The bot will pause at the bank portal for manual authentication.
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || profiles.length === 0}
          className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-600/10"
        >
          {loading ? "Creating..." : "Create Job"}
        </button>
      </form>
    </div>
  );
}
