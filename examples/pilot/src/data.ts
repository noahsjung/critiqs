export interface User {
  id: string;
  name: string;
  department: string;
  role: "Admin" | "Editor" | "Viewer";
}

export const users: User[] = Array.from({ length: 200 }, (_, index) => ({
  id: `u${index + 1}`,
  name: index === 0 ? "Alex Kim" : index === 1 ? "Sam Rivera" : `User ${index + 1}`,
  department: ["Sales", "Support", "Engineering", "Design"][index % 4]!,
  role: (["Admin", "Editor", "Viewer"] as const)[index % 3]!,
}));

/** Demo personas the prototype can show. Context only; never a reviewer's identity. */
export const personas = ["Admin", "Regional manager", "Read-only auditor"];
