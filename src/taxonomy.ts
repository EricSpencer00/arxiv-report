// The full arXiv subject taxonomy — official category display names, grouped by
// top-level field in arXiv's own order. Source: https://arxiv.org/category_taxonomy
//
// These names double as plain-English interest phrases: the semantic ranker embeds
// each one, so any of them is an honest query regardless of field (the keyword
// fallback's CATEGORY_AFFINITY map in keywords.ts is a separate, CS-focused concern).

export interface SubjectGroup {
  group: string;
  topics: string[];
}

const RAW_SUBJECTS: SubjectGroup[] = [
  {
    group: "Computer Science",
    topics: [
      "Artificial Intelligence",
      "Hardware Architecture",
      "Computational Complexity",
      "Computational Engineering, Finance, and Science",
      "Computational Geometry",
      "Computation and Language",
      "Cryptography and Security",
      "Computer Vision and Pattern Recognition",
      "Computers and Society",
      "Databases",
      "Distributed, Parallel, and Cluster Computing",
      "Digital Libraries",
      "Discrete Mathematics",
      "Data Structures and Algorithms",
      "Emerging Technologies",
      "Formal Languages and Automata Theory",
      "General Literature",
      "Graphics",
      "Computer Science and Game Theory",
      "Human-Computer Interaction",
      "Information Retrieval",
      "Information Theory",
      "Machine Learning",
      "Logic in Computer Science",
      "Multiagent Systems",
      "Multimedia",
      "Mathematical Software",
      "Numerical Analysis",
      "Neural and Evolutionary Computing",
      "Networking and Internet Architecture",
      "Other Computer Science",
      "Operating Systems",
      "Performance",
      "Programming Languages",
      "Robotics",
      "Symbolic Computation",
      "Sound",
      "Software Engineering",
      "Social and Information Networks",
      "Systems and Control",
    ],
  },
  {
    group: "Economics",
    topics: ["Econometrics", "General Economics", "Theoretical Economics"],
  },
  {
    group: "Electrical Engineering and Systems Science",
    topics: [
      "Audio and Speech Processing",
      "Image and Video Processing",
      "Signal Processing",
      "Systems and Control",
    ],
  },
  {
    group: "Mathematics",
    topics: [
      "Commutative Algebra",
      "Algebraic Geometry",
      "Analysis of PDEs",
      "Algebraic Topology",
      "Classical Analysis and ODEs",
      "Combinatorics",
      "Category Theory",
      "Complex Variables",
      "Differential Geometry",
      "Dynamical Systems",
      "Functional Analysis",
      "General Mathematics",
      "General Topology",
      "Group Theory",
      "Geometric Topology",
      "History and Overview",
      "Information Theory",
      "K-Theory and Homology",
      "Logic",
      "Metric Geometry",
      "Mathematical Physics",
      "Numerical Analysis",
      "Number Theory",
      "Operator Algebras",
      "Optimization and Control",
      "Probability",
      "Quantum Algebra",
      "Rings and Algebras",
      "Representation Theory",
      "Symplectic Geometry",
      "Spectral Theory",
      "Statistics Theory",
    ],
  },
  {
    group: "Physics",
    topics: [
      // Astrophysics
      "Cosmology and Nongalactic Astrophysics",
      "Earth and Planetary Astrophysics",
      "Astrophysics of Galaxies",
      "High Energy Astrophysical Phenomena",
      "Instrumentation and Methods for Astrophysics",
      "Solar and Stellar Astrophysics",
      // Condensed Matter
      "Disordered Systems and Neural Networks",
      "Mesoscale and Nanoscale Physics",
      "Materials Science",
      "Other Condensed Matter",
      "Quantum Gases",
      "Soft Condensed Matter",
      "Statistical Mechanics",
      "Strongly Correlated Electrons",
      "Superconductivity",
      // Relativity, high-energy, nuclear, math-phys
      "General Relativity and Quantum Cosmology",
      "High Energy Physics - Experiment",
      "High Energy Physics - Lattice",
      "High Energy Physics - Phenomenology",
      "High Energy Physics - Theory",
      "Mathematical Physics",
      "Nuclear Experiment",
      "Nuclear Theory",
      // Nonlinear Sciences
      "Adaptation and Self-Organizing Systems",
      "Chaotic Dynamics",
      "Cellular Automata and Lattice Gases",
      "Pattern Formation and Solitons",
      "Exactly Solvable and Integrable Systems",
      // Physics
      "Accelerator Physics",
      "Atmospheric and Oceanic Physics",
      "Applied Physics",
      "Atomic and Molecular Clusters",
      "Atomic Physics",
      "Biological Physics",
      "Chemical Physics",
      "Classical Physics",
      "Computational Physics",
      "Data Analysis, Statistics and Probability",
      "Physics Education",
      "Fluid Dynamics",
      "General Physics",
      "Geophysics",
      "History and Philosophy of Physics",
      "Instrumentation and Detectors",
      "Medical Physics",
      "Optics",
      "Plasma Physics",
      "Popular Physics",
      "Physics and Society",
      "Space Physics",
      // Quantum Physics
      "Quantum Physics",
    ],
  },
  {
    group: "Quantitative Biology",
    topics: [
      "Biomolecules",
      "Cell Behavior",
      "Genomics",
      "Molecular Networks",
      "Neurons and Cognition",
      "Other Quantitative Biology",
      "Populations and Evolution",
      "Quantitative Methods",
      "Subcellular Processes",
      "Tissues and Organs",
    ],
  },
  {
    group: "Quantitative Finance",
    topics: [
      "Computational Finance",
      "Economics",
      "General Finance",
      "Mathematical Finance",
      "Portfolio Management",
      "Pricing of Securities",
      "Risk Management",
      "Statistical Finance",
      "Trading and Market Microstructure",
    ],
  },
  {
    group: "Statistics",
    topics: [
      "Applications",
      "Computation",
      "Methodology",
      "Machine Learning",
      "Other Statistics",
      "Statistics Theory",
    ],
  },
];

// De-duplicate topic names globally (a name cross-listed under several archives —
// e.g. "Machine Learning" in both CS and Statistics — is kept only on first sight)
// and sort each group alphabetically for a scannable list.
export const ARXIV_SUBJECTS: SubjectGroup[] = (() => {
  const seen = new Set<string>();
  return RAW_SUBJECTS.map(({ group, topics }) => {
    const kept: string[] = [];
    for (const topic of topics) {
      const key = topic.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(topic);
    }
    kept.sort((a, b) => a.localeCompare(b));
    return { group, topics: kept };
  });
})();

// Flattened, de-duplicated list of every arXiv topic name.
export const ALL_INTERESTS: string[] = ARXIV_SUBJECTS.flatMap((g) => g.topics);

// Curated broad default shown before the user expands "show all" — one or more
// picks from every major field so the collapsed view isn't CS-only.
export const DEFAULT_INTERESTS: string[] = [
  "Machine Learning",
  "Computer Vision and Pattern Recognition",
  "Cryptography and Security",
  "Robotics",
  "Logic in Computer Science",
  "Number Theory",
  "Optimization and Control",
  "Cosmology and Nongalactic Astrophysics",
  "High Energy Physics - Theory",
  "Quantum Physics",
  "Materials Science",
  "Genomics",
  "Neurons and Cognition",
  "Econometrics",
  "Statistics Theory",
];
