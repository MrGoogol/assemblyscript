(module
 (type $i (func (result i32)))
 (type $v (func))
 (global $HEAP_BASE i32 (i32.const 8))
 (table 1 1 anyfunc)
 (elem (i32.const 0) $null)
 (memory $0 0)
 (export "memory" (memory $0))
 (export "default" (func $named-export-default/get3))
 (func $named-export-default/get3 (; 0 ;) (type $i) (result i32)
  (i32.const 3)
 )
 (func $null (; 1 ;) (type $v)
 )
)
