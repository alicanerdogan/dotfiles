; Lexical declaration name (variable name)
(lexical_declaration
  (variable_declarator
    name: (identifier) @variable.name))

; Lexical declaration value (the assigned value)
(lexical_declaration
  (variable_declarator
    value: (_) @variable.value))
