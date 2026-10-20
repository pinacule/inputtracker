import { THEMES, type ThemeId } from "../lib/theme";
import { CheckIcon } from "./icons";

/** Native radio inputs provide arrow-key selection and one tab stop per group.
 * Preview scopes use exactly the live theme tokens, not a second skin model. */
export function ThemePicker({ value, onChange }: {
  value: ThemeId;
  onChange: (theme: ThemeId) => void;
}) {
  return (
    <fieldset class="theme-picker">
      <legend class="sr-only">App skin</legend>
      <div class="theme-tiles-grid">
        {THEMES.map((theme) => (
          <label class="theme-tile" key={theme.id}>
            <input
              class="theme-tile-radio sr-only"
              type="radio"
              name="inputtracker-theme"
              value={theme.id}
              checked={value === theme.id}
              onChange={() => onChange(theme.id)}
            />
            <span class="theme-tile-body">
              <span class="theme-preview" data-theme={theme.id} aria-hidden="true">
                <span class="theme-preview-window">
                  <span class="theme-preview-titlebar">
                    <span class="theme-preview-heading">{theme.label}</span>
                    <span class="theme-preview-window-button">−</span>
                  </span>
                  <span class="theme-preview-data">
                    <span class="theme-preview-label">■ Today</span>
                    <span class="theme-preview-number">time: 2h 48m</span>
                  </span>
                  <span class="theme-preview-bars">
                    {["anime", "series", "film", "book"].map((category, index) => (
                      <span key={category} style={{
                        backgroundColor: `var(--cat-${category}-solid)`,
                        width: `${[35, 25, 23, 17][index]}%`,
                      }} />
                    ))}
                  </span>
                </span>
              </span>
              <span class="theme-tile-title">
                <strong>{theme.label}</strong>
                <span class="theme-tile-check" aria-hidden="true"><CheckIcon size={16} /></span>
              </span>
              <span class="theme-tile-description">{theme.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
