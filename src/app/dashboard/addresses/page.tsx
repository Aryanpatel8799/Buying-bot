"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface SavedAddressEntry {
  _id: string;
  name: string;
  maskedMobile: string;
  pincode: string;
  locality: string;
  addressLine1: string;
  city: string;
  state: string;
  addressType: "Home" | "Work";
  maskedGstNumber: string;
  gstNumber: string;
  companyName: string;
  createdAt: string;
}

const INDIAN_STATES = [
  "Andaman & Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra & Nagar Haveli & Daman & Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu & Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttarakhand",
  "Uttar Pradesh",
  "West Bengal",
];

export default function AddressesPage() {
  const { status } = useSession();
  const router = useRouter();

  const [addresses, setAddresses] = useState<SavedAddressEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<Record<string, string | undefined>>({});
  const [serverError, setServerError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  // Form fields
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [pincode, setPincode] = useState("");
  const [locality, setLocality] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [addressType, setAddressType] = useState<"Home" | "Work">("Home");
  const [gstNumber, setGstNumber] = useState("");
  const [companyName, setCompanyName] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchAddresses();
  }, [status, router]);

  async function fetchAddresses() {
    setLoading(true);
    try {
      const res = await fetch("/api/addresses");
      if (res.ok) setAddresses(await res.json());
    } finally {
      setLoading(false);
    }
  }

  function validateForm(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Name is required";
    if (!mobile.trim()) errors.mobile = "Mobile number is required";
    else if (!/^\d{10}$/.test(mobile)) errors.mobile = "Must be exactly 10 digits";
    if (!pincode.trim()) errors.pincode = "Pincode is required";
    else if (!/^\d{6}$/.test(pincode)) errors.pincode = "Must be exactly 6 digits";
    if (!locality.trim()) errors.locality = "Locality is required";
    if (!addressLine1.trim()) errors.addressLine1 = "Address is required";
    if (!city.trim()) errors.city = "City is required";
    if (!state) errors.state = "State is required";
    if (!gstNumber.trim()) errors.gstNumber = "GST number is required";
    if (!companyName.trim()) errors.companyName = "Company name is required";
    return errors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errors = validateForm();
    setFormError(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    setServerError("");
    setSuccessMsg("");

    try {
      const res = await fetch("/api/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          mobile,
          pincode,
          locality: locality.trim(),
          addressLine1: addressLine1.trim(),
          city: city.trim(),
          state,
          addressType,
          gstNumber: gstNumber.trim(),
          companyName: companyName.trim(),
        }),
      });

      if (res.ok) {
        setSuccessMsg("Address saved successfully!");
        setName("");
        setMobile("");
        setPincode("");
        setLocality("");
        setAddressLine1("");
        setCity("");
        setState("");
        setGstNumber("");
        setCompanyName("");
        setAddressType("Home");
        setFormError({});
        setShowForm(false);
        fetchAddresses();
      } else {
        const data = await res.json();
        if (data.details) {
          const mapped: Record<string, string> = {};
          for (const d of data.details) {
            mapped[d.path.join(".")] = d.message;
          }
          setFormError(mapped);
        } else {
          setServerError(data.error || "Failed to save address");
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this address?")) return;
    const res = await fetch(`/api/addresses/${id}`, { method: "DELETE" });
    if (res.ok) fetchAddresses();
  }

  function fieldClass(field: string) {
    return `w-full px-4 py-2.5 bg-gray-800 border rounded-xl text-white focus:outline-none focus:ring-2 transition-all ${
      formError[field]
        ? "border-red-500/50 focus:ring-red-500/40"
        : "border-gray-700 focus:ring-blue-500/40 focus:border-blue-500/40"
    }`;
  }

  if (status === "loading" || loading) {
    return <div className="text-gray-500 text-center py-12">Loading...</div>;
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">GST Addresses</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Save delivery addresses with GST invoice details
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
            showForm
              ? "bg-gray-800 text-gray-300 border border-gray-700"
              : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/10"
          }`}
        >
          {showForm ? "Cancel" : "+ Add Address"}
        </button>
      </div>

      {/* Alerts */}
      {serverError && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
          {serverError}
        </div>
      )}
      {successMsg && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm">
          {successMsg}
        </div>
      )}

      {/* Add Address Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-5">
            Add New Address with GST
          </h2>

          {/* GST Details Section */}
          <div className="mb-5 pb-5 border-b border-gray-800">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              GST Invoice Details
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  GST Number
                </label>
                <input
                  type="text"
                  value={gstNumber}
                  onChange={(e) => {
                    setGstNumber(e.target.value);
                    setFormError((p) => ({ ...p, gstNumber: undefined }));
                  }}
                  placeholder="27AALCD3578N1ZW"
                  maxLength={15}
                  className={fieldClass("gstNumber")}
                />
                {formError.gstNumber && (
                  <p className="text-xs text-red-400 mt-1">{formError.gstNumber}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  Company Name
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => {
                    setCompanyName(e.target.value);
                    setFormError((p) => ({ ...p, companyName: undefined }));
                  }}
                  placeholder="DASH MOBILES PRIVATE LIMITED"
                  className={fieldClass("companyName")}
                />
                {formError.companyName && (
                  <p className="text-xs text-red-400 mt-1">{formError.companyName}</p>
                )}
              </div>
            </div>
          </div>

          {/* Delivery Address Section */}
          <div className="mb-5 pb-5 border-b border-gray-800">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Delivery Address
            </h3>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setFormError((p) => ({ ...p, name: undefined }));
                  }}
                  placeholder="John Doe"
                  className={fieldClass("name")}
                />
                {formError.name && (
                  <p className="text-xs text-red-400 mt-1">{formError.name}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  10-digit Mobile Number
                </label>
                <input
                  type="text"
                  value={mobile}
                  onChange={(e) => {
                    setMobile(e.target.value.replace(/\D/g, "").slice(0, 10));
                    setFormError((p) => ({ ...p, mobile: undefined }));
                  }}
                  placeholder="9876543210"
                  maxLength={10}
                  className={fieldClass("mobile")}
                />
                {formError.mobile && (
                  <p className="text-xs text-red-400 mt-1">{formError.mobile}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  Pincode
                </label>
                <input
                  type="text"
                  value={pincode}
                  onChange={(e) => {
                    setPincode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setFormError((p) => ({ ...p, pincode: undefined }));
                  }}
                  placeholder="400001"
                  maxLength={6}
                  className={fieldClass("pincode")}
                />
                {formError.pincode && (
                  <p className="text-xs text-red-400 mt-1">{formError.pincode}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  Locality
                </label>
                <input
                  type="text"
                  value={locality}
                  onChange={(e) => {
                    setLocality(e.target.value);
                    setFormError((p) => ({ ...p, locality: undefined }));
                  }}
                  placeholder="Andheri East"
                  className={fieldClass("locality")}
                />
                {formError.locality && (
                  <p className="text-xs text-red-400 mt-1">{formError.locality}</p>
                )}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                Address (Area and Street)
              </label>
              <textarea
                value={addressLine1}
                onChange={(e) => {
                  setAddressLine1(e.target.value);
                  setFormError((p) => ({ ...p, addressLine1: undefined }));
                }}
                placeholder="Swaroop Chamber, Office No 1, Sahar Pipeline Road, Andheri East"
                rows={3}
                className={fieldClass("addressLine1")}
              />
              {formError.addressLine1 && (
                <p className="text-xs text-red-400 mt-1">{formError.addressLine1}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  City / District / Town
                </label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                    setFormError((p) => ({ ...p, city: undefined }));
                  }}
                  placeholder="Mumbai"
                  className={fieldClass("city")}
                />
                {formError.city && (
                  <p className="text-xs text-red-400 mt-1">{formError.city}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                  State
                </label>
                <select
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                    setFormError((p) => ({ ...p, state: undefined }));
                  }}
                  className={fieldClass("state")}
                >
                  <option value="">--Select State--</option>
                  {INDIAN_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {formError.state && (
                  <p className="text-xs text-red-400 mt-1">{formError.state}</p>
                )}
              </div>
            </div>

            {/* Address Type */}
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                Address Type
              </label>
              <div className="flex gap-4">
                {(["Home", "Work"] as const).map((type) => (
                  <label
                    key={type}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border cursor-pointer transition-all text-sm ${
                      addressType === type
                        ? "bg-blue-600/10 border-blue-500/40 text-blue-400"
                        : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    <input
                      type="radio"
                      name="addressType"
                      value={type}
                      checked={addressType === type}
                      onChange={() => setAddressType(type)}
                      className="hidden"
                    />
                    {type}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <button
            type="submit"
            onClick={handleSubmit}
            disabled={saving}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
          >
            {saving ? "Saving..." : "Save Address"}
          </button>
        </div>
      )}

      {/* Addresses Table */}
      {addresses.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-500">No saved addresses yet.</p>
          <p className="text-sm text-gray-600 mt-1">
            Add an address to use GST invoicing during checkout.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {addresses.map((addr) => (
            <div
              key={addr._id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  {/* GST Info */}
                  <div className="flex items-center gap-3 mb-3">
                    <span className="font-mono text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-lg">
                      {addr.maskedGstNumber}
                    </span>
                    <span className="text-sm font-medium text-gray-200">
                      {addr.companyName}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border ${
                        addr.addressType === "Home"
                          ? "bg-gray-800 text-gray-400 border-gray-700"
                          : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                      }`}
                    >
                      {addr.addressType}
                    </span>
                  </div>

                  {/* Delivery Address */}
                  <div className="text-sm text-gray-300 space-y-0.5">
                    <p className="font-medium text-white">{addr.name}</p>
                    <p>
                      {addr.addressLine1}
                      {addr.locality && `, ${addr.locality}`}
                    </p>
                    <p>
                      {addr.city} — {addr.pincode}, {addr.state}
                    </p>
                    <p className="text-gray-500">{addr.maskedMobile}</p>
                  </div>
                </div>

                <button
                  onClick={() => handleDelete(addr._id)}
                  className="text-sm text-red-400 hover:text-red-300 transition-colors font-medium shrink-0"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
