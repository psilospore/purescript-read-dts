module Test.Main where

import Prelude

import Data.Array (catMaybes, (:))
import Data.Array (cons) as Array
import Data.Foldable (fold, foldM, foldMap, for_)
import Data.Map (Map)
import Data.Map (fromFoldable, insert, lookup) as Map
import Data.Maybe (Maybe(..), isNothing)
import Data.Newtype (class Newtype, unwrap)
import Data.String (joinWith)
import Data.Traversable (for, sequence, traverse)
import Data.Tuple (Tuple(..))
import Debug.Trace (trace)
import Effect (Effect)
import Effect.Console (log)
import Effect.Ref (modify, modify', new, read) as Ref
import Global.Unsafe (unsafeStringify)
import Matryoshka (cata)
import Matryoshka.Class.Corecursive (embed)
import ReadDTS (FullyQualifiedName(..), OnDeclaration, OnType, TsDeclaration, TypeReference, Declarations, compilerOptions, readDTS)
import ReadDTS.AST (build, pprintDeclaration) as AST
import Unsafe.Coerce (unsafeCoerce)

type TsDeclarationRef= { fullyQualifiedName ∷ FullyQualifiedName, tsDeclaration ∷ TsDeclaration }
type TypeRepr = { repr ∷ String, tsDeclarations ∷ Array TsDeclarationRef }
newtype DeclarationRepr = DeclarationRepr
  { fullyQualifiedName ∷ Maybe FullyQualifiedName
  , repr ∷ String
  , tsDeclarations ∷ Array TsDeclarationRef
  }
derive instance newtypeDeclarationRepr ∷ Newtype DeclarationRepr _

stringOnDeclaration ∷ OnDeclaration DeclarationRepr TypeRepr
stringOnDeclaration =
  { interface: \i → DeclarationRepr
      { fullyQualifiedName: Just i.fullyQualifiedName
      , repr: serInterface i
      , tsDeclarations:
          foldMap _.tsDeclarations i.typeParameters
          <> foldMap _.type.tsDeclarations i.properties
      }
  -- | It seems that type aliases don't introduce names so they don't
  -- | have fullyQualifiedName... but of course I can be wrong.
  , typeAlias: \r@{ type: t, typeParameters } → DeclarationRepr
      { fullyQualifiedName: Nothing
      , repr: serTypeAlias r
      , tsDeclarations: t.tsDeclarations <> foldMap _.tsDeclarations typeParameters
      }
  , unknown: \u → DeclarationRepr
      { repr: serUnknown u
      , fullyQualifiedName: u.fullyQualifiedName
      , tsDeclarations: []
      }
  }

serUnknown r = "unkownDeclaration " <> show r.fullyQualifiedName <> ": " <> r.msg

serTypeAlias r
  = "typeAlias "
  <> r.name
  <> " <" <> joinWith ", " (map _.repr r.typeParameters) <> "> : "
  <> r.type.repr

serInterface { name, fullyQualifiedName, properties, typeParameters }
  = "interface "
  <> show fullyQualifiedName
  <> " <" <> joinWith ", " (map _.repr typeParameters) <> "> : \n\t"
  <> joinWith ";\n\t" (map onMember properties)
  where
    onMember r = joinWith " " [r.name, if r.optional then "?:" else ":", r.type.repr ]

noDeclarations ∷ String → TypeRepr
noDeclarations repr = { repr, tsDeclarations: [] }

stringOnType ∷ OnType DeclarationRepr TypeRepr
stringOnType =
  { anonymousObject: \props →
      let
        onMember r = joinWith " " [r.name, if r.optional then "?:" else ":", r.type.repr ]
      in
        { repr: "{" <> (joinWith " , " (map onMember props)) <> "}"
        , tsDeclarations: foldMap _.type.tsDeclarations props
        }
  , array: \t → { repr: "Array: " <> t.repr, tsDeclarations: t.tsDeclarations }
  , intersection: \ts →
      { repr: append "intersection: " <<< joinWith " & " <<< map _.repr $ ts
      , tsDeclarations: foldMap _.tsDeclarations ts
      }
  , primitive: noDeclarations <<< append "primitive: " <<< show
  , tuple: \ts →
      { repr: "(" <> (joinWith ", " $ map _.repr ts) <> ")"
      , tsDeclarations: foldMap _.tsDeclarations ts
      }
  , typeParameter: case _ of
      { default: Nothing, identifier } → noDeclarations $ unsafeStringify identifier
      { default: Just d, identifier } →
          { repr: unsafeStringify identifier <> " = " <> d.repr
          , tsDeclarations: d.tsDeclarations
          }
  , typeReference: \{ fullyQualifiedName, ref, typeArguments } →
      { repr: "typeReference: " <> show fullyQualifiedName <> "<" <> joinWith ", " (map _.repr typeArguments) <> ">"
      , tsDeclarations: { fullyQualifiedName, tsDeclaration: ref } :foldMap _.tsDeclarations typeArguments
      }
  , union: \ts →
      { repr: append "union: " <<< joinWith " | " <<< map _.repr $ ts
      , tsDeclarations: foldMap _.tsDeclarations ts
      }
  , unknown: noDeclarations <<< append "unknown: " <<< show
  }

fileName ∷ String
fileName = "test/simple.d.ts"

main ∷ Effect Unit
main = do
  { topLevel, readDeclaration } ← readDTS compilerOptions { onDeclaration: stringOnDeclaration, onTypeNode: stringOnType } fileName
  for_ topLevel \(DeclarationRepr r) → do
     log r.repr
     log "\n"

  -- | Single pass of loading... We should test exhaustive loading too.
  let
    initCache = Map.fromFoldable <<< catMaybes <<< map case _ of
      d@(DeclarationRepr { fullyQualifiedName: Just fullyQualifiedName }) → Just (Tuple fullyQualifiedName d)
      otherwise → Nothing
    cache = initCache topLevel

    step c { fullyQualifiedName, tsDeclaration } = case fullyQualifiedName `Map.lookup` c of
      Nothing → readDeclaration tsDeclaration >>= flip (Map.insert fullyQualifiedName) c >>> pure
      Just _ → pure c

  log "Single pass of loading declarations...\n\n"

  cache' ← foldM step cache (foldMap (unwrap >>> _.tsDeclarations) topLevel)

  log "Collected declarations:\n\n"

  for_ cache' \(DeclarationRepr r) → do
     log r.repr
     log "\n"

  result ← AST.build fileName
  log $ unsafeStringify $ unsafeCoerce $ result

  log $ joinWith "\n\n" $ ((map (_.repr <<< cata AST.pprintDeclaration <<< embed) result))

  pure unit
