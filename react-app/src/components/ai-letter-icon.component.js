import React from "react";

// An "Ai" lettermark -- thin-stroke letters with a swooping crossbar on the
// "A" and a four-pointed sparkle as the dot of the "i". Spelling out "AI"
// reads at a glance in a way an abstract sparkles mark alone didn't. Inline
// SVG (FontAwesome 5's free set has nothing like it) in currentColor, so it
// takes the surrounding text color.
const AiLetterIcon = ({ size = 24 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.8 20L8.8 4.5L14.8 20" />
    <path d="M4.6 15.6Q9.6 11.4 13.4 17.6" />
    <path d="M19 11V20" />
    <path
      d="M19 3.2Q19.35 6 22.1 6.35Q19.35 6.7 19 9.5Q18.65 6.7 15.9 6.35Q18.65 6 19 3.2Z"
      fill="currentColor"
      stroke="none"
    />
  </svg>
);

export default AiLetterIcon;
