import { useId } from 'react';
import s from './Field.module.css';

type FieldProps = {
  label: string;
  hint: string;
  error?: string;
  value: string;
  placeholder?: string;
  autoFocus?: boolean;
  numeric?: boolean;
  onChange: (value: string) => void;
};

/** 입력 칸 하나. 이름은 칸 제목만, 안내·오류 문장은 설명(aria-describedby)으로 읽힌다. */
export function Field({ label, hint, error, value, placeholder, autoFocus, numeric, onChange }: FieldProps) {
  const hintId = useId();
  return (
    <label className={s.root}>
      <span className="t-label-md c-secondary">{label}</span>
      <input
        className={`${s.input} t-body-md`}
        aria-label={label}
        aria-describedby={hintId}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        inputMode={numeric ? 'numeric' : undefined}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={hintId} className={`t-caption ${error ? 'c-danger' : 'c-tertiary'}`}>
        {error ?? hint}
      </span>
    </label>
  );
}
