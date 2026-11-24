export function AirGuide() {
  return (
    <details className="panel air-guide">
      <summary>Chart guide &amp; level references</summary>
      <p className="section-note">
        Charts use separate labeled scales for each unit. Solid lines show
        bucket averages; dashed lines show peaks. Hover, tap, or use arrow keys
        to inspect readings. Green OK and orange Warning compare each reading
        with its named reference; warnings show the excess in the measurement’s
        units. The next row shows reading ÷ reference × 100; percentages above
        100% are bold red. A higher peak takes priority and is labeled Peak.
        These comparisons do not establish safe exposure.
      </p>
      <div className="air-guide-grid">
        <p>
          <strong>CO₂ · ventilation</strong>Above 1,000 ppm is our early
          reminder; above 1,500 ppm, improve ventilation if readings persist.
          Red indicators start at 2,000 ppm as a stronger reminder. These are
          ventilation indicators, not toxicity limits.{" "}
          <a
            href="https://www.hse.gov.uk/ventilation/using-co2-monitors.htm"
            target="_blank"
            rel="noopener noreferrer"
          >
            HSE guidance ↗
          </a>
        </p>
        <p>
          <strong>Particles · daily exposure</strong>WHO’s 24-hour references
          are 15 µg/m³ for PM2.5 and 45 µg/m³ for PM10. Card indicators use a
          time-weighted daily average once at least 90% of the day is covered.
          Chart lines are daily references, not instant danger thresholds.{" "}
          <a
            href="https://www.who.int/teams/environment-climate-change-and-health/air-quality-and-health/health-impacts/types-of-pollutants"
            target="_blank"
            rel="noopener noreferrer"
          >
            WHO guidelines ↗
          </a>
        </p>
        <p>
          <strong>VOC / NOₓ · relative changes</strong>VOC’s learned baseline is
          100; NOₓ’s is 1. Colors follow Sensirion’s air-purifier response
          bands. These indexes do not measure a gas concentration or establish
          toxic exposure. Zero or missing readings mean unavailable.{" "}
          <a
            href="https://sensirion.com/media/documents/ACD82D45/6294DFC0/Info_Note_Integration_VOC_NOx_Sensor.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sensirion index guide ↗
          </a>
        </p>
      </div>
      <p className="section-note">
        Humidity warnings use EPA’s below-60% ceiling and 30% ideal minimum; the
        ideal range is 30–50%. Differences use percentage points (pp).{" "}
        <a
          href="https://www.epa.gov/mold/brief-guide-mold-moisture-and-your-home"
          target="_blank"
          rel="noopener noreferrer"
        >
          EPA humidity guidance ↗
        </a>{" "}
        Temperature, PM1, and PM4.0 have no applied limit and stay neutral.
      </p>
      <p className="section-note">
        This monitor cannot establish that printer emissions are safe: it does
        not identify individual vapors or measure all ultrafine particles.
      </p>
    </details>
  );
}
