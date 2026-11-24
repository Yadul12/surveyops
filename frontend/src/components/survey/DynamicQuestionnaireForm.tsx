import React from 'react';
import { MapPin } from 'lucide-react';
import { evaluateConditionalLogic } from '@/lib/conditionalLogic';
import type { Question } from '@/types';

interface Props {
  questions: Question[];
  answers: Record<string, unknown>;
  onChange: (questionKey: string, value: unknown) => void;
  errors?: Record<string, string>;
  readOnly?: boolean;
  compact?: boolean;
}

export function DynamicQuestionnaireForm({
  questions,
  answers,
  onChange,
  errors = {},
  readOnly = false,
  compact = false,
}: Props) {
  const ordered = [...questions].sort((a, b) => a.order_index - b.order_index);
  const visibleQuestions = ordered.filter((q) => evaluateConditionalLogic(q.conditional_logic, answers));

  // Group consecutively by section_title
  const sections: Array<{ title: string; items: Question[] }> = [];
  visibleQuestions.forEach((q) => {
    const title = q.section_title || 'General';
    const last = sections[sections.length - 1];
    if (!last || last.title !== title) {
      sections.push({ title, items: [q] });
    } else {
      last.items.push(q);
    }
  });

  if (visibleQuestions.length === 0) {
    return (
      <div className="rounded-sm border border-hairline bg-canvas p-4 text-center text-[12.5px] text-navy-500">
        No visible questions configured in this survey version.
      </div>
    );
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      {sections.map((section) => (
        <div key={section.title} className="space-y-3">
          <div className="border-b border-hairline pb-1 text-[11px] font-semibold uppercase tracking-wider text-teal-accent">
            {section.title}
          </div>

          {section.items.map((q) => {
            const val = answers[q.question_key];
            const err = errors[q.question_key];
            const unit = typeof q.config?.unit === 'string' ? q.config.unit : '';
            const placeholder = typeof q.config?.placeholder === 'string' ? q.config.placeholder : '';

            return (
              <div
                key={q.question_key}
                className={`rounded-sm border ${
                  err ? 'border-crimson-border bg-crimson-tint/15' : 'border-hairline bg-surface'
                } p-3.5`}
              >
                <div className="flex items-start justify-between gap-2">
                  <label className="block text-[13px] font-medium text-navy leading-snug">
                    {q.prompt}
                    {q.is_required && <span className="ml-1 text-crimson-err">*</span>}
                  </label>
                  <span className="shrink-0 font-mono text-[10.5px] text-navy-400">{q.question_key}</span>
                </div>
                {q.help_text && <p className="mt-1 text-[11.5px] text-navy-500">{q.help_text}</p>}

                <div className="mt-2.5">
                  {q.question_type === 'short_text' && (
                    <input
                      type="text"
                      disabled={readOnly}
                      value={val !== undefined && val !== null ? String(val) : ''}
                      onChange={(e) => onChange(q.question_key, e.target.value)}
                      placeholder={placeholder || 'Enter answer...'}
                      className="ops-input"
                    />
                  )}

                  {q.question_type === 'long_text' && (
                    <textarea
                      rows={3}
                      disabled={readOnly}
                      value={val !== undefined && val !== null ? String(val) : ''}
                      onChange={(e) => onChange(q.question_key, e.target.value)}
                      placeholder={placeholder || 'Enter detailed field notes...'}
                      className="ops-input"
                    />
                  )}

                  {q.question_type === 'number' && (
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        step="any"
                        disabled={readOnly}
                        value={val !== undefined && val !== null ? String(val) : ''}
                        onChange={(e) => onChange(q.question_key, e.target.value === '' ? '' : Number(e.target.value))}
                        placeholder={placeholder || '0'}
                        className="ops-input max-w-[200px] tabular-nums"
                      />
                      {unit && <span className="text-[12px] text-navy-500">{unit}</span>}
                    </div>
                  )}

                  {q.question_type === 'date' && (
                    <input
                      type="date"
                      disabled={readOnly}
                      value={val !== undefined && val !== null ? String(val) : ''}
                      onChange={(e) => onChange(q.question_key, e.target.value)}
                      className="ops-input max-w-[220px]"
                    />
                  )}

                  {q.question_type === 'boolean' && (
                    <div className="flex gap-2">
                      {[
                        { label: 'Yes', value: true },
                        { label: 'No', value: false },
                      ].map((opt) => {
                        const selected = val === opt.value || String(val) === String(opt.value);
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={readOnly}
                            onClick={() => onChange(q.question_key, opt.value)}
                            className={`flex-1 rounded-sm border px-3 py-2 text-[12.5px] font-medium transition-colors ${
                              selected
                                ? 'border-teal-accent bg-teal-tint text-teal-accent'
                                : 'border-hairlineStrong bg-surface text-navy-600 hover:bg-canvas'
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {q.question_type === 'rating' && (
                    <div className="flex flex-wrap gap-1.5">
                      {Array.from(
                        { length: Math.max(2, Number(q.config?.max || 5) - Number(q.config?.min || 1) + 1) },
                        (_, idx) => Number(q.config?.min || 1) + idx
                      ).map((num) => {
                        const selected = Number(val) === num;
                        return (
                          <button
                            key={num}
                            type="button"
                            disabled={readOnly}
                            onClick={() => onChange(q.question_key, num)}
                            className={`h-9 w-11 rounded-sm border text-[13px] font-semibold tabular-nums transition-colors ${
                              selected
                                ? 'border-teal-accent bg-teal-accent text-white'
                                : 'border-hairlineStrong bg-surface text-navy hover:bg-canvas'
                            }`}
                          >
                            {num}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {q.question_type === 'single_choice' && (
                    <div className="space-y-1.5">
                      {(q.options || []).map((opt) => {
                        const selected = String(val ?? '') === opt.value;
                        return (
                          <label
                            key={opt.value}
                            className={`flex cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2 text-[12.5px] transition-colors ${
                              selected
                                ? 'border-teal-accent bg-teal-tint/60 text-navy font-medium'
                                : 'border-hairline bg-canvas/30 text-navy-700 hover:bg-canvas'
                            }`}
                          >
                            <input
                              type="radio"
                              name={q.question_key}
                              disabled={readOnly}
                              checked={selected}
                              onChange={() => onChange(q.question_key, opt.value)}
                              className="accent-teal-accent"
                            />
                            <span>{opt.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {q.question_type === 'multi_choice' && (
                    <div className="space-y-1.5">
                      {(q.options || []).map((opt) => {
                        const list = Array.isArray(val) ? (val as string[]) : [];
                        const selected = list.includes(opt.value);
                        return (
                          <label
                            key={opt.value}
                            className={`flex cursor-pointer items-center gap-2.5 rounded-sm border px-3 py-2 text-[12.5px] transition-colors ${
                              selected
                                ? 'border-teal-accent bg-teal-tint/60 text-navy font-medium'
                                : 'border-hairline bg-canvas/30 text-navy-700 hover:bg-canvas'
                            }`}
                          >
                            <input
                              type="checkbox"
                              disabled={readOnly}
                              checked={selected}
                              onChange={() => {
                                const next = selected
                                  ? list.filter((x) => x !== opt.value)
                                  : [...list, opt.value];
                                onChange(q.question_key, next);
                              }}
                              className="accent-teal-accent"
                            />
                            <span>{opt.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {q.question_type === 'location' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => {
                          if (navigator.geolocation) {
                            navigator.geolocation.getCurrentPosition(
                              (pos) =>
                                onChange(q.question_key, {
                                  lat: Number(pos.coords.latitude.toFixed(6)),
                                  lng: Number(pos.coords.longitude.toFixed(6)),
                                  accuracy: Math.round(pos.coords.accuracy),
                                }),
                              () => onChange(q.question_key, { lat: 40.758, lng: -73.9855, accuracy: 18 })
                            );
                          } else {
                            onChange(q.question_key, { lat: 40.758, lng: -73.9855, accuracy: 18 });
                          }
                        }}
                        className="ops-btn-secondary"
                      >
                        <MapPin className="h-3.5 w-3.5 text-teal-accent" />
                        Capture Consented Coordinates
                      </button>
                      {Boolean(val && typeof val === 'object' && 'lat' in (val as Record<string, unknown>)) && (
                        <span className="font-mono text-[11.5px] text-teal-accent">
                          {(val as { lat: number; lng: number }).lat}, {(val as { lat: number; lng: number }).lng}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {err && <p className="mt-1.5 text-[11.5px] font-medium text-crimson-err">{err}</p>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
